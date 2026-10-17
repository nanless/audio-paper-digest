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
const CORE_SUMMARY_METRIC_PATTERN = /(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|CA-SDRi|SDRi|SNRi|SDR|SNR|EER|UAR|PPL|NLL|negative[ -]log[ -]likelihood|false[ -]acceptance[ -]rate|unsafe[ -]response[ -]rate|safety[ -]understanding[ -]rate|deepfake[ ]+FAR|TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S|ILD[- ]W|ASR|mAP|gAP|AUROC|AUC|GMR|GMC|ECE|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R1@(?:0(?:\.\d+)?|1(?:\.0+)?)(?![.\d@])|R@\d+(?:\.\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|MotionQ|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])E2E(?=[ ]*(?:比例|命中率|成功率))|(?:皮尔逊(?:积矩)?相关系数|斯皮尔曼(?:秩)?相关系数|肯德尔(?:秩相关|和谐|协调|一致性)系数)(?!\s*(?:的)?(?:模型|方法|基线|算法|网络))|字错率|评估损失(?:终值)?(?=[^。；\n]{0,90}(?:[二两三四五六七八九十百1-9][0-9]*(?:\.\d+)?倍|(?:为|是|从)\s*\d+(?:\.\d+)?))|不安全回答率|安全理解率|伪造假接受率|耳间强度差(?:Wasserstein)?距离|平均绝对误差|端到端命中率|有用性偏好率|均方根误差|词(?:字)?错率|困惑度|负对数似然|攻击成功率|准确率|正确率|错误率|误差率|期望校准误差|召回率|精确率|总体分|得分|分数|胜率|成功率|延迟|吞吐|实时率|对数谱失真|两耳声级差误差|正确拒绝率|真负率|真阳性率|检出率|(?:人类|人工)(?:语义)?评分|主观评分|客观评分|相似度|相似分数|性能|指标)/i;
// 会议论文常用领域内的中文指标名（例如 DAFx 的“抖动”和“包络相关”）。
// 这里显式列出来，免得把任何结果名词都当成定量证据。
const CORE_SUMMARY_CONFERENCE_METRIC_PATTERN = /包络相关(?:性)?|抖动|计数偏差|总误差|频率误差|衰减误差|增益误差|相对误差|平均误差|压缩率|谐波失真|频谱对比度损失|起音时间(?:对数)?偏差|(?:对数似然比代价(?:[ \t]*[Cc][Ll][Ll][Rr](?![A-Za-z0-9_])|(?![ \t-]*[Cc][Ll][Ll][Rr]))|声对比度|声压级)(?=[ \t]*(?:指标|分数|得分)?(?:为|是|从|升至|降至)[ \t]*[-+]?[0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_.]))/;
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
const TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE = /^(?:(?:评价|问卷)项目(?:[，,]\s*N\s*=\s*\d+)?|目标|蒸馏目标|环节|(?:distillation )?objective|训练损失|损失函数|监督目标|训练目标|评估设置|实验设置|提取来源|任务向量来源|表示|检测器|生成器|组合|声源|音源|乐器|sound sources?|audio sources?|instruments?|分割规则|领域|合并点|合并位置|提示词|对比对象|被试\s*ID|预训练目标|训练数据|分词器|家族|NFE|number of function evaluations|函数求值次数|词表大小(?:\s*\$\\\|V\\\|\$)?|segmentation rule|domain|merge point|prompt|comparison object|participant\s+ID|pretraining objective|training data|tokenizer|vocabulary size)$/i;
function isTableIdentifierHeader(value) {
    const normalized = String(value || '').trim();
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
        if (boundary && !comment && !htmlLiteral) { fence = boundary[1]; return blank(); }
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

function sourceBackedIdentityColumns(table, sourceText) {
    const rawSource = String(sourceText || '');
    const source = rawSource.replace(/\s+/g, '');
    const captions = [...rawSource.matchAll(/(?:^|\n)(?:Table\s+(?:[A-Z]?\d+|[IVXLCDM]+)|表\s*\d+)\s*[:：]/gmi)];
    const blocks = captions.map((match, index) => {
        const block = rawSource.slice(match.index,
            Math.min(captions[index + 1]?.index ?? rawSource.length, match.index + 20000));
        const heading = /(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][^\n]{0,100}|(?:conclusions?|discussion|references?|appendix)(?:[ :：][^\n]{0,80})?)(?:\n|$)/im.exec(block);
        return heading ? block.slice(0, heading.index) : block;
    });
    return new Set(table.header.flatMap((header, index) => {
        if (table.rows.length < 2) return [];
        const labels = table.rows.map(row => String(row[index] || '').trim());
        if (String(header).trim() === '来源') {
            const completeLabels = labels.every(label => label.length >= 1 && label.length <= 80 && /\p{L}/u.test(label));
            return completeLabels && blocks.some(block => {
                const lines = new Set(block.split('\n').map(line => line.trim()));
                return lines.has('Source') && labels.every(label => lines.has(label));
            }) ? [index] : [];
        }
        if (!/^(?:损失|loss)$/i.test(String(header).trim())) return [];
        return labels.every(label => {
            const match = /^\$?(\\mathcal\{L\}_\{\\(?:text|mathrm)\{[A-Za-z]{1,24}\}\})\$?$/.exec(label);
            return match && source.includes(match[1]);
        }) ? [index] : [];
    }));
}

function hasReportedExperimentPhrase(text, pattern) {
    return [...String(text).matchAll(pattern)].some(match => {
        const prefix = String(text).slice(Math.max(0, match.index - 60), match.index)
            .split(/[。！？；\n]/).at(-1);
        return !/(?:并非|不是|未能|没有|尚未|未曾|不能|不应|如果|假设|假如|倘若|若|未|不|计划|讨论|建议|拟|将|未来|有待|打算|设想)[^，,]{0,30}$/.test(prefix);
    });
}

function hasSourceBackedTrainingStageAblation(tables, sourceText) {
    const source = String(sourceText || '');
    const removal = /\b(?:w\/?o|without)\s+(?:the\s+)?(?:two[- ]stage\s+training\b|second[- ]stage\s+(?:training|fine[- ]tuning)\b)/gi;
    const supported = [...source.matchAll(removal)].some(match =>
        !/\b(?:no|not|never|plans?|planning|planned|propos(?:e|ed)|hypothetical|may|might|could|would|future)\b[^.;\n]{0,80}$/i.test(
            source.slice(Math.max(0, match.index - 100), match.index)));
    if (!supported) return false;
    // A translated, measured row identifies the removed training component;
    // a generic zero-shot claim or a mention in prose does not establish it.
    return tables.some(table => table.header.some((header, column) =>
        isTableIdentifierHeader(String(header).replace(/[*_`]/g, '').trim())
        && table.rows.some(row => /^(?:无|省略)第(?:二|2)阶段(?:训练|微调)$/.test(
            String(row[column] || '').replace(/[*_`]/g, '').trim()))));
}

function hasSourceBackedZeroCorrectionAblation(results, sourceText) {
    const source = String(sourceText || '').replace(/\s+/g, ' ');
    // A measured correction sweep isolates this component; a zero weight in
    // training settings, or a proposed future sweep, does not establish it.
    const sweep = /Role of bidirectional correction\.[\s\S]{0,500}?isolates the correction signal[\s\S]{0,500}?varying only[\s\S]{0,500}?without correction/i.exec(source);
    if (!sweep || /\b(?:future|planned|hypothetical)\b/i.test(sweep[0])) return false;
    for (const match of String(results || '').matchAll(/修正权重\s*为\s*0(?:\.0+)?\s*时\s*(Total)\s*最高\s*[,，]\s*为\s*(\d+(?:\.\d+)?)/gi)) {
        const value = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefix = String(results).slice(Math.max(0, match.index - 60), match.index);
        if (!/(?:如果|假设|计划|未来|可能|预计|并非|不是)[^。；\n]{0,50}$/.test(prefix)
            && /λcorr\s+Quality\s+Semantic\s+Total/i.test(sweep[0])
            && new RegExp(`(?:^| )0 +[0-9.]+ +[0-9.]+ +${value}(?![0-9.])`).test(sweep[0])) return true;
    }
    return false;
}

function hasSourceBackedRewardSwitchAblation(results, tables, sourceText) {
    const source = String(sourceText || '');
    if (!/\bablation\b/i.test(source) || !/\brewards?\b/i.test(source)) return false;
    const transitions = String(results).split(/[。；\n]/u).flatMap(sentence => {
        if (/(?:他人|其他模型|另一(?:个|种)(?:模型|系统)|无关(?:模型|系统)|否定|驳斥|转述)|(?:说法|表述|观点|判断)[^。；\n]{0,20}(?:错误|有误|不成立|不正确)/u.test(sentence)) return [];
        if (/(?:假设|假想|如果|计划|未来|预计|可能|先前工作|相关工作|此前研究|并非|不是|没有|尚未|未曾|未|不|是否|尚无|未知|待评估|值得|有待|否认|反驳|引用|引述|错误说法|[?？])/u.test(sentence)) return [];
        const match = /(?:加入|只开|开启|关闭|移除|去掉)[^。；\n]{1,30}奖励[^。；\n]{0,120}(?:从|由)\s*([0-9]+(?:\.[0-9]+)?)%?\s*(?:升至|降至|升到|降到)\s*([0-9]+(?:\.[0-9]+)?)%?/u.exec(sentence);
        return match ? [[Number(match[1]), Number(match[2])]] : [];
    });
    if (!transitions.length) return false;
    const state = value => ['✓', '✔'].includes(String(value).trim()) ? 1 : /^[-—✗×]$/.test(String(value).trim()) ? 0 : null;
    const value = cell => /^\s*([0-9]+(?:\.[0-9]+)?)%?\s*$/.exec(String(cell))?.[1];
    const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return tables.some(table => {
        const controls = table.header.flatMap((header, index) => /^R[a-z]{2,12}$/.test(String(header).trim()) ? [index] : []);
        const identifier = table.header.findIndex(header => isTableIdentifierHeader(String(header).trim()));
        if (controls.length < 2 || identifier < 0 || controls.some(column => {
            const suffix = String(table.header[column]).trim().slice(1);
            return !source.includes(`\\mathrm{${suffix}}`) && !source.includes(`ℛ${suffix}`);
        })) return false;
        const labels = new Set(table.rows.map(row => String(row[identifier]).trim()));
        const matchesSource = row => lines.some((line, index) => {
            if (line !== String(row[identifier]).trim()) return false;
            let end = index + 1;
            while (end < lines.length && !labels.has(lines[end])) end++;
            const body = lines.slice(index + 1, end);
            if (controls.some((column, offset) => state(body[offset]) !== state(row[column]) || state(row[column]) === null)) return false;
            return row.every((cell, column) => column === identifier || controls.includes(column)
                || (value(cell) !== undefined && body.includes(value(cell))));
        });
        return table.rows.some((first, index) => table.rows.slice(index + 1).some(second =>
            first[identifier] === second[identifier] && matchesSource(first) && matchesSource(second)
            && controls.filter(column => state(first[column]) !== state(second[column])).length === 1
            && table.header.some((_header, column) => column !== identifier && !controls.includes(column)
                && value(first[column]) !== undefined && value(second[column]) !== undefined
                && Number(value(first[column])) !== Number(value(second[column]))
                && transitions.some(([from, to]) => from === Number(value(first[column])) && to === Number(value(second[column]))
                    || to === Number(value(first[column])) && from === Number(value(second[column]))))));
    });
}

function hasTableBoundHigherMetricRegression(results, tables, sourceText) {
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prose = String(results || '').split('\n').filter(line => !/^\s*\|/.test(line)).join('\n');
    // Some PDF tables flatten a grouped header to `Method NFE Group↑ X↑ Y↑
    // Overall Text Diversity ...`; the group's leaf values occupy the row tail.
    // Accept this exact rectangular shape, never a bare metric elsewhere in text.
    const sourceLines = String(sourceText || '').split('\n');
    const groupedTables = [];
    for (const [lineIndex, line] of sourceLines.entries()) {
        if (!/^\s*Method\s+NFE\s+/i.test(line)) continue;
        const captionContext = sourceLines.slice(Math.max(0, lineIndex - 6), lineIndex).join(' ');
        if (!/\bTable\s+(?:\d+|[IVXLCDM]+)[.:：]/i.test(captionContext)
            || /\b(?:hypothetical|future|planned|illustrative|example)\b/i.test(captionContext)) continue;
        const groups = [...line.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{1,50}\s*↑/g)];
        if (!groups.length) continue;
        const leafHeaders = line.slice(groups.at(-1).index + groups.at(-1)[0].length).trim().split(/\s+/);
        if (leafHeaders.length < 2 || leafHeaders.length > 12
            || !leafHeaders.every(name => /^[A-Za-z][A-Za-z0-9_.-]{0,30}$/.test(name))) continue;
        const rows = [];
        for (const rowLine of sourceLines.slice(lineIndex + 1, lineIndex + 41)) {
            const row = /^\s*(\S(?:.*?\S)?)\s+(\d+(?:\.\d+)?(?:\s*(?:×|x)\s*\d+)?(?:\s+\d+(?:\.\d+)?){2,})\s*$/.exec(rowLine);
            if (!row) break;
            const values = row[2].match(/\d+(?:\.\d+)?/g);
            const minimum = leafHeaders.length + groups.length;
            if (values.length !== minimum + (/\s[×x]\s/.test(row[2]) ? 1 : 0)) break;
            rows.push([row[1], ...values.slice(-leafHeaders.length)]);
        }
        if (rows.length >= 2) groupedTables.push({header:['Method', ...leafHeaders.map(name => `${name} ↑`)], rows, sourceGrouped:true});
    }
    for (const table of [...tables, ...groupedTables]) for (const [column, header] of table.header.entries()) {
        const metric = String(header).replace(/[*_`$]/g, '').replace(/(?:↑|\\uparrow)/g, '').trim();
        if (!/^[A-Za-z][A-Za-z0-9.-]{1,30}$/.test(metric)
            || !/(?:↑|\\uparrow)/.test(header)
            || (!table.sourceGrouped && !new RegExp(`\\b${escape(metric)}[\\s($]*(?:↑|\\\\uparrow)`, 'i').test(String(sourceText || '')))) continue;
        const pattern = new RegExp(`\\b${escape(metric)}(?![A-Za-z0-9_-])[^。；\\n]{0,60}?(?:为|是)\\s*(\\d+(?:\\.\\d+)?)\\s*[,，]\\s*(?:略|明显|显著)?低于\\s*([^，。；\\n]{1,60}?)\\s*的\\s*(\\d+(?:\\.\\d+)?)`, 'gi');
        for (const match of prose.matchAll(pattern)) {
            const prefix = prose.slice(Math.max(0, match.index - 60), match.index);
            if (/(?:如果|假设|计划|未来|可能|预计|并非|不是|没有)[^。；\n]{0,50}$/.test(prefix)
                || /(?:如果|假设|计划|未来|可能|预计|并非|不是|没有)/.test(match[0])
                || !(Number(match[1]) < Number(match[3]))) continue;
            const centralValue = cell => /^\s*(\d+(?:\.\d+)?)(?:\s|$|±)/.exec(String(cell || ''))?.[1];
            const first = table.rows.find(row => Number(centralValue(row[column])) === Number(match[1]));
            const second = table.rows.find(row => Number(centralValue(row[column])) === Number(match[3])
                && row.some((cell, index) => index !== column && isTableIdentifierHeader(table.header[index])
                    && String(cell).replace(/[*_`]/g, '').trim().replace(/^Teacher$/i, '教师')
                        === match[2].trim().replace(/^Teacher$/i, '教师')));
            if (first && second && first !== second) return true;
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
        const boundaryPattern = /(?:相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化|仅[^。；\n]{1,40}(?:保持|达到)?显著|只说明|不支持|(?:证据|结论)(?:范围)?限于)/;
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
    const resultHasAblation = hasSourceBackedTrainingStageAblation(tables, sourceAblationEvidence)
        || hasSourceBackedZeroCorrectionAblation(results, sourceAblationEvidence)
        || /\bablation\b|\bw\/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|消融|移除|去掉|不含|排除|无外推/i.test(results)
        // 有的论文只用 `+ L_j`、`+ L_s` … 标注消融行，正文里说是逐级叠加。
        // 只要原文确实有消融，这仍然算显式的组件对照。
        || /(?:逐级|逐步|依次)(?:叠加|加入|添加|移除|比较)|(?:组件|约束|模块|损失|监督目标|局部配对|竞争归一化)[^。；\n]{0,24}(?:对照|贡献|差异|是否必要|必要性)/i.test(results)
        || /\+\s*L[_\s]?[A-Za-z](?:\s*\+\s*L[_\s]?[A-Za-z])+/i.test(results)
        || hasReportedExperimentPhrase(results,
            /(?:分离|隔离)[^。；\n]{1,24}(?:贡献|影响|作用)|(?:比较|对照)[^。；\n]{0,24}(?:组件|模块|门控)[^。；\n]{0,12}(?:组合|配置)/g);
    const reportedRewardAblation = hasSourceBackedRewardSwitchAblation(results, tables, sourceAblationEvidence);
    if (empirical && sourceHasAblation && !resultHasAblation && !reportedRewardAblation) {
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
    const resultHasNegative = contextualNegative
        || hasTableBoundHigherMetricRegression(results, tables, options.sourceText)
        || explicitMetricDecline
        || reportedLowerScore
        || reportedBiasRegression
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

function hasBoundFormerLatterComparison(sentence) {
    // Resolve former/latter only for two explicit measured values under one
    // named metric. A parameter count elsewhere cannot supply either value.
    if (/(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)/u.test(sentence)) return false;
    const metric = '(?:均方根误差|平均绝对误差|RMSE|MAE|词错误率|WER)';
    const number = '[-+]?\\d+(?:\\.\\d+)?';
    const value = `(${number})(?:\\s*±\\s*${number})?\\s*(%|％|dB|ms|s)?`;
    const pattern = new RegExp(`${metric}比较[，,]\\s*([^，,。；]{1,40}?)(?:为|是)\\s*${value}`
        + `[，,]\\s*([^，,。；]{1,40}?)(?:为|是)\\s*${value}`
        + '[，,]\\s*(前者|后者)(更高|更低)', 'iu');
    const match = pattern.exec(sentence);
    if (!match) return false;
    const [, first, a, unitA = '', second, b, unitB = '', referent, direction] = match;
    const namedObject = /拟合|模型|系统|方法|基线|对照|条件|分支|输入|编码器/u;
    if (first.trim() === second.trim() || !namedObject.test(first) || !namedObject.test(second)
        || unitA.replace('％', '%') !== unitB.replace('％', '%')
        || CORE_SUMMARY_METRIC_PATTERN.test(first) || CORE_SUMMARY_METRIC_PATTERN.test(second)) return false;
    const left = Number(referent === '前者' ? a : b), right = Number(referent === '前者' ? b : a);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) return false;
    return direction === '更低' ? left < right : left > right;
}

function hasBoundDisjointIntervalComparison(sentence) {
    // Recognize two measured ranges, never turn their endpoints into exact points.
    const clause = String(sentence || '').split(/[；;。！？!?\n]/u)[0];
    if (clause.length > 800 || /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)/u.test(clause)) return false;
    const surface = clause.replace(/（[^（）]{0,180}）|\([^()]{0,180}\)/gu, '');
    const metric = '(?:词错误率|词错率|字错率|准确率|正确率|错误率|召回率|精确率|WER|CER|EER|UAR|accuracy|precision|recall|均方根误差|平均绝对误差|RMSE|MAE|SNR|SI-SDR|延迟|latency)';
    const number = '[-+]?\\d+(?:\\.\\d+)?';
    const range = `(${number})\\s*(%|％|dB|ms|s)\\s*[–—~～至到-]\\s*(${number})\\s*(%|％|dB|ms|s)`;
    const measured = `([^，,。；;]{1,80}?)的(${metric})(?:大约为|大约|约为|约|为|是)\\s*${range}`;
    const pattern = new RegExp(`(?:^|[，,])\\s*${measured}[，,]\\s*${measured}[，,]\\s*(前者|后者)(更高|更低)\\s*$`, 'iu');
    const m = pattern.exec(surface);
    if (!m) return false;
    const [, first, metricA, a0, ua0, a1, ua1, second, metricB, b0, ub0, b1, ub1, referent, direction] = m;
    const namedObject = /拟合|模型|系统|方法|基线|对照|条件|分支|编码器|提示|微调|算法|网络/u;
    if (first.trim() === second.trim() || !namedObject.test(first) || !namedObject.test(second)
        || CORE_SUMMARY_METRIC_PATTERN.test(first) || CORE_SUMMARY_METRIC_PATTERN.test(second)) return false;
    const canonicalMetric = value => ({'词错率':'wer','词错误率':'wer','字错率':'cer','准确率':'accuracy','正确率':'accuracy','召回率':'recall','精确率':'precision','均方根误差':'rmse','平均绝对误差':'mae','延迟':'latency'}[value] || value.toLowerCase());
    const key = canonicalMetric(metricA), unit = ua0.replace('％', '%');
    if (key !== canonicalMetric(metricB) || [ua1, ub0, ub1].some(value => value.replace('％', '%') !== unit)) return false;
    if ((/^(?:wer|cer|eer|uar|accuracy|precision|recall|错误率)$/.test(key) && unit !== '%')
        || (/^(?:snr|si-sdr)$/.test(key) && unit !== 'dB')
        || (key === 'latency' && !['s', 'ms'].includes(unit))) return false;
    const values = [a0, a1, b0, b1].map(Number);
    if (values.some(value => !Number.isFinite(value) || value < 0 || (unit === '%' && value > 100))
        || values[0] >= values[1] || values[2] >= values[3]) return false;
    const [leftMin, leftMax, rightMin, rightMax] = referent === '前者' ? values : [values[2], values[3], values[0], values[1]];
    return direction === '更低' ? leftMax < rightMin : leftMin > rightMax;
}

function hasConditionalMetricDeltaDirection(sentence) {
    // One named rate, two explicit conditions, and a measured percentage-point
    // delta in the same clause. Bare higher/lower or model-size changes fail.
    if (/(?:假设|假想|如果|可能|预计|计划|未来|并非|并未|未报告|未测|没有观察到)/u.test(sentence)) return false;
    const pattern = /(?:准确率|正确率|错误率|词错率|(?<![A-Za-z0-9_])(?:WER|EER|UAR|accuracy)(?![A-Za-z0-9_]))(?:差|差值|差距)?在([^，,。；;]{1,60}?)(?:时|条件下)比([^，,。；;]{1,60}?)(?:时|条件下)(?:平均|总体)?(?:高|低)(?:了|出)?\s*(\d+(?:\.\d+)?)\s*(?:个百分点|百分比点|pp)(?![A-Za-z])/giu;
    for (const match of sentence.matchAll(pattern)) {
        if (match[1].trim() === match[2].trim() || Number(match[3]) <= 0
            || CORE_SUMMARY_METRIC_PATTERN.test(match[1] + match[2])) continue;
        return true;
    }
    return false;
}

function hasCoreSummaryComparisonDirection(sentence, numbers) {
    // 示意图里的 "from inputs to outputs" 是映射关系，不是实测提升。
    // 数字上的变化必须写明起始值。
    const directionSurface = sentence.replace(/\bfrom\b([^。！？!?]{0,50})\bto\b/gi,
        (match, between) => /\d/.test(between) ? match : ' ');
    if (hasConditionalMetricDeltaDirection(sentence) || hasBoundFormerLatterComparison(sentence) || hasBoundDisjointIntervalComparison(sentence) || CORE_SUMMARY_COMPARISON_PATTERN.test(directionSurface)
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

// 图的有向边连接的是符号节点，不是两个标量测量值。
function stripSymbolicPatternRelation(text) {
    const identifier = String.raw`(?:[A-Z]\d+(?:[A-Z]_\{\d+\})?|[A-Z]_\{\d+\})`;
    const relation = new RegExp(String.raw`\bedge\s+from\s+pattern\s+${identifier}\s+to\s+pattern\s+${identifier}(?![A-Za-z0-9_])`, 'g');
    return String(text || '').replace(relation, match => ' '.repeat(match.length));
}

function hasSymbolicGeometryMethodChain(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
    const denied = /讨论|提及|如果|若|是否|应该|应当|建议|假设|假想|假定|设想|预计|预期|可能|计划|拟将|拟把|未来|准备|并非|不是|另一(?:个|种|套|组|批)|(?:不同|其他|无关)的?点集|独立方法|(?:不|未|没有)(?:曾|实际|直接|真正|进行|再|被|确实|把|将|会|能|以)*\s*(?:转为|转成|转换|编码|生成|输出|进入|作为|检验|判断|收成|映射)/u;
    for (let index = 0; index < sentences.length; index++) {
        const producer = sentences[index];
        const encoding = producer.split(/[，,]/u)[0];
        if (denied.test(encoding) || !/^编码(?:先)?(?:把|将)(?:每个|每一|各个)?音(?:符)?(?:转为|转成|转换为|编码为)(?:二维|音高时间平面上的)点(?:集)?/u.test(encoding)) continue;
        const transfers = producer.split(/[，,]/u).filter(clause =>
            !denied.test(clause) && /(?:输出的|得到的|形成的|组合的)?点集(?:直接)?(?:进入几何(?:匹配|判定)|作为(?:下一步)?几何(?:匹配|判定)的输入)/u.test(clause));
        if (!transfers.length) continue;
        // 下游必须在当前句或紧邻下一句实际检验变换重合，不能从远处借模块词。
        const next = sentences[index + 1] || '';
        const processors = [producer, next].flatMap(sentence => sentence.split(/[，,]/u));
        if (processors.some(clause => !denied.test(clause)
            && /^(?:几何(?:匹配|判定)|匹配)(?:在[^，,]{1,75}上(?:以)?)?(?:检验|判断|能否)[^，,]{0,80}变换[^，,]{0,50}(?:重合|映射)/u.test(clause))) return true;
    }
    return false;
}

function hasScopedSymbolicDemonstration(summary) {
    if (!hasSymbolicGeometryMethodChain(summary)) return false;
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u);
    // 实例结构中的组规模不是性能指标；具体标量性能主张仍须有实测来源。
    const performanceClaims = sentences.some(sentence => {
        const metricSurface = sentence.replace(/(?:变换)?等价组规模为指标/gu, ' ');
        return CORE_SUMMARY_METRIC_PATTERN.test(metricSurface)
            && ((sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || []).length > 0
                || /(?:百分之|千分之|零点)[零一二两三四五六七八九十百千万点]+/u.test(sentence));
    });
    if (performanceClaims) return false;
    const scoped = sentences.some(sentence => !/假设|假想|预计|可能|未来|讨论|提及|不只|并非|不是/u.test(sentence)
        && /结论(?:只|仅)在[^。]{0,55}(?:该曲|作品|主题实例|实例)[^。]{0,25}(?:有证据|成立|得到支持|得到验证)/u.test(sentence));
    const limit = sentences.flatMap(sentence => sentence.split(/[，,]/u)).some(clause =>
        !/并非|不是|不能|已经|已(?:经|得到)?验证/u.test(clause)
        && /跨作品[^，,。]{0,45}(?:尚未|未)(?:得到)?验证/u.test(clause));
    return scoped && limit;
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

// 保留原逐行表格边界；列名缩写的句点不能把数值行和真实结果表标题隔开。
function sourceHasMeasuredMetricTable(sourceText) {
    const lines = String(sourceText || '').split(/\r?\n/).map(line => line.trim());
    const numericCell = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*(?:%|％|dB))?$/;
    for (let index = 0; index < lines.length; index++) {
        const caption = lines[index];
        if (!/^Table\s+\d+\s*:\s*(?:Comparison|Ablation|Evaluation|Benchmark|Results)\b/i.test(caption)
            || /\b(?:hypothetical|illustrative|example|planned|expected|predicted|prior study|previous study)\b/i.test(caption)
            || /\b(?:results?|measurements?)\b[^.;]{0,25}\b(?:not|never)\b[^.;]{0,25}\b(?:observed|measured|reported|evaluated)\b|\b(?:no|without)\s+(?:(?:observed|measured|reported|evaluated)\s+)?results?\b|\b(?:not|never)\s+(?:observed|measured|reported|evaluated)\s+results?\b/i.test(caption)) continue;
        const rows = [];
        let metricHeader = false, label = '', values = [];
        const flush = () => { if (label && values.length) rows.push({ label, width: values.length }); values = []; };
        for (let next = index + 1; next < Math.min(lines.length, index + 100); next++) {
            const line = lines[next];
            if (/^\d+(?:\.\d+)*\s+[A-Z][A-Za-z]/.test(line) || /^Table\s+\d+\s*:/i.test(line)) break;
            if (!line) continue;
            if (numericCell.test(line)) { values.push(line); continue; }
            if (/^[–—-]$/.test(line) && values.length) continue;
            flush();
            const withoutCitations = line.replace(/\[[\d,\s]+\]/g, '').trim();
            const specificMetric = withoutCitations.replace(new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' ');
            if (!rows.length && (CORE_SUMMARY_METRIC_PATTERN.test(specificMetric)
                || /^(?:SRCC|LRCC)$/i.test(withoutCitations))) metricHeader = true;
            label = /^[A-Za-z][A-Za-z0-9 .+_-]{1,80}$/.test(withoutCitations)
                && !/^(?:Method|Metric|Metrics|Parameter|Parameters|Dataset|Datasets)$/i.test(withoutCitations)
                && !CORE_SUMMARY_METRIC_PATTERN.test(specificMetric)
                && !/^(?:SRCC|LRCC)$/i.test(withoutCitations) ? withoutCitations : '';
        }
        flush();
        if (metricHeader && rows.some((row, first) => rows.slice(first + 1)
            .some(other => other.label !== row.label && other.width === row.width))) return true;
    }
    return false;
}

// 文本语料发布论文的清洗结果不是模型性能；仅识别同一发布中可核的前后计数。
function sourceCorpusCurationResult(sourceText) {
    const text = String(sourceText || '').replace(/\s+/g, ' ').trim();
    if (!/\b(?:text corpus|corpus|dataset)\b/i.test(text.slice(0, 2500))
        || !/(?:^|[.!?]\s+)(?:This paper describes the release of (?:its|our) text component|We (?:release|publish) (?:a|our|the|this) text corpus)\b/i.test(text.slice(0, 2500))) return null;
    const count = '(?:[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d*)';
    const observed = new RegExp(`\\b(?:A )?second pass was carried out for this release[^.]{0,160}\\.[\\s\\S]{0,180}?(?<![\\d.])(${count}) of the (${count}) (?:lines|rows|sentences) were not in NFC form\\b`, 'i').exec(text);
    const removed = new RegExp(`\\bAlso corrected:\\s*(${count}) exact duplicates\\b`, 'i').exec(text);
    const statistics = new RegExp(`\\bCorpus statistics\\b[\\s\\S]{0,100}?Rows in the \\d{4} working file\\s*(${count})\\s*Unique sentences after cleaning\\s*(${count})\\b`, 'i').exec(text);
    if (!observed || !removed || !statistics) return null;
    const numeric = value => Number(value.replace(/,/g, ''));
    const result = { invalid: numeric(observed[1]), original: numeric(observed[2]), removed: numeric(removed[1]), cleaned: numeric(statistics[2]) };
    if (Object.values(result).some(value => !Number.isSafeInteger(value) || value <= 0)
        || numeric(statistics[1]) !== result.original || result.invalid > result.original
        || result.original - result.removed !== result.cleaned) return null;
    return result;
}

function hasCompleteCorpusCurationResult(summary, result) {
    if (!result || !/(?:语料|句子|文本)/.test(summary)) return false;
    const sentences = String(summary).replace(/(?<=\d),(?=\d)/g, '').split(/[。！？!?\n]/);
    return sentences.some(sentence => {
        if (/(?:未发现|没有发现|尚未检查|计划|预计|假设|拟检查)/.test(sentence)) return false;
        const value = number => `(?<![\\d.])${number}(?![\\d.])`;
        const counts = new RegExp(`${value(result.original)}\\s*(?:行|句)[^。]{0,20}(?:中有|其中有|中)\\s*${value(result.invalid)}\\s*(?:行|句)[^。]{0,20}(?:不符合|不满足|未采用)\\s*NFC`, 'i');
        const reverseCounts = new RegExp(`${value(result.invalid)}\\s*(?:行|句)[^。]{0,15}(?:不符合|不满足|未采用)\\s*NFC[^。]{0,30}(?:原有|原始|共|全部)\\s*${value(result.original)}\\s*(?:行|句)`, 'i');
        const clean = new RegExp(`(?:修复|清洗|规范化|去重)[^。]{0,30}后[^。]{0,12}(?:得到|保留|剩余|形成|共有)\\s*${value(result.cleaned)}\\s*(?:个)?(?:唯一)?(?:句子|句|行)[^。]{0,8}(?:唯一|句子|文本)?`);
        const cleaned = clean.exec(sentence);
        const cleaningNegated = cleaned && /(?:未|未曾|从未|没有|尚未|不)(?:进行|完成)?\s*$/.test(sentence.slice(Math.max(0, cleaned.index - 12), cleaned.index));
        return /(?:发现|检查|清洗|统计)/.test(sentence) && (counts.test(sentence) || reverseCounts.test(sentence)) && cleaned && !cleaningNegated;
    });
}

// Software functional validation is source-bound repeatability evidence, not model performance.
function sourceSoftwareFunctionalValidationResult(sourceText){
 const count=value=>/^\d+$/u.test(value)?Number(value):({one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12}[String(value).toLowerCase()]??NaN);
 const text=String(sourceText||'').replace(/\s+/gu,' ').trim(),word='(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
 // Keep this affirmative observed provenance local. A quoted prior result,
 // future validation, version/step numbers or a test inventory cannot match.
 const observed=new RegExp('(?:^|[.!?] )On a pinned ([A-Za-z]+) ([A-Za-z0-9_-]+) and Python (\\d+\\.\\d+) stack, functional validation of the pre-release versions reproduced package and host tests\\. '+word+' runs in fresh processes reproduced the same render-plan hash and all '+word+' expected output hashes, covering '+word+' sampled parameter configurations and '+word+' fixed MIDI signals; (\\d+) negative cases also passed\\.','iu').exec(text);
 if(!observed)return null;
 const result={os:observed[1],architecture:observed[2],pythonVersion:observed[3],runs:count(observed[4]),outputs:count(observed[5]),configurations:count(observed[6]),midiSignals:count(observed[7]),negativeCases:count(observed[8])};
 // Independent table statement authenticates which counts belong to outputs,
 // configurations and signals. Counts are bound by roles, not a numeric bag.
 const table=new RegExp('Deterministic workflow '+word+' fresh processes each rendered and kept '+word+' records from '+word+' parameter configurations and '+word+' MIDI signals; both reproduced the same expected plan hash and all '+word+' expected output-byte hashes\\.','iu').exec(text);
 const packageTests=/Package tests (\d+) passed; wheel\/source build and clean wheel installation passed\./iu.exec(text);
 const negativeCases=/Negative cases (\d+) passed, covering/iu.exec(text);
 const tableCaption=/Table\s+\d+: Quality-control results from the pre-release validation pass on the pinned ([A-Za-z]+) ([A-Za-z0-9_-]+) and Python (\d+\.\d+) stack\./iu.exec(text);
 if(!table||!packageTests||!negativeCases||!tableCaption)return null;
 result.packageTests=count(packageTests[1]);
 if([result.runs,result.outputs,result.configurations,result.midiSignals,result.negativeCases,result.packageTests].some(n=>!Number.isSafeInteger(n)||n<=0)
  ||result.negativeCases!==count(negativeCases[1])||result.runs<2||result.outputs!==result.configurations*result.midiSignals
  ||[result.runs,result.outputs,result.configurations,result.midiSignals,result.outputs].some((n,i)=>n!==count(table[i+1]))
  ||[result.os,result.architecture,result.pythonVersion].some((v,i)=>v.toLowerCase()!==tableCaption[i+1].toLowerCase()))return null;
 return {...result,observedQuote:observed[0].replace(/^[.!?] /u,''),workflowQuote:table[0],packageTestsQuote:packageTests[0],captionQuote:tableCaption[0]};
}
function hasCompleteSoftwareFunctionalValidationResult(summary,result){
 if(!result)return false;
 const count=value=>/^\d+$/u.test(value)?Number(value):({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十二':12}[value]??NaN);
 const text=String(summary||'');
 // Forbid unsupported model-performance claims as a replacement for this
 // software result; the existing generic benchmark rules remain untouched.
 return text.split(/[。！？!?\n]/u).some(sentence=>{
  if(/假设|假想|如果|(?:^|[，,])若|预计|未来|建议|(?:计划|预期)(?:将|会|在|用|复现|验证|运行|渲染|测试)|先前工作|此前工作|旧工作|相关工作|其他(?:软件|工具|系统|方法)|另一(?:软件|工具|系统)|基线|引用|转述|否认|反驳|驳斥|是否|吗/u.test(sentence)
   ||/(?:未|没有|无法|不)(?:曾|实际|能|会|再)?(?:复现|通过|匹配|保持一致|运行|渲染)|(?:说法|表述|结论)[^。]{0,30}(?:错误|不成立|不正确)/u.test(sentence))return false;
  const clean=sentence.replace(/\s+/gu,''),stack='在锁定的'+result.os+result.architecture+'与Python'+result.pythonVersion+'组合上';
  if(!clean.startsWith(stack))return false;
  const m=/([0-9一二两三四五六七八九十]+)次全新进程渲染均复现了同一采样计划哈希与([0-9一二两三四五六七八九十]+)个预期输出哈希覆盖([0-9一二两三四五六七八九十]+)组采样参数与([0-9一二两三四五六七八九十]+)个固定MIDI信号，([0-9一二两三四五六七八九十]+)个负向用例与([0-9一二两三四五六七八九十]+)个包测试同样通过$/u.exec(clean.slice(stack.length).replace(/^，/u,''));
  return Boolean(m&&[result.runs,result.outputs,result.configurations,result.midiSignals,result.negativeCases,result.packageTests].every((n,i)=>n===count(m[i+1])));
 });
}

function sourceHasObservedOutcomeComparison(sourceText) {
    // Source-only evidence. A numeric definition, a scale, or a planned test is
    // not an observation. Keep the measured object/condition and its result in
    // one bounded statement; never infer source evidence from the summary.
    const paragraphs = String(sourceText || '').replace(/\r/g, '').split(/\n[ \t]*\n/)
        .map(value => value.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    const denied = /\b(?:hypothetical|illustrative|suppose|assuming|predicted|expected|planned|future|will|would|could|should)\b|\bwe\s+hypothesi[sz]e\b|\b(?:prior|previous|earlier|another|other)\s+(?:work|stud(?:y|ies)|research|paper)\b|\b(?:cited|quoted|quotation|denies|denied|refutes|refuted)\b|\b(?:et\s+al\.?|reviewer|commentator)\s+(?:report(?:s|ed)?|write[sd]?|wrote|says?|said|claims?|claimed)\b|\b(?:not|never|no)\s+(?:(?:actually|actual|yet|empirically|be|been|ever)\s+)*(?:measur|observ|evaluat|perform|conduct|carri|run|test|report|found|confirm|yield|show|averag|var|surpass|produc|trigger|shift)|\b(?:as\s+(?:a\s+)?(?:stopping\s+|selection\s+|decision\s+)?threshold|hyperparameter)\b|\b(?:define|defines|defined|definition|assume|assumes|assumed)\b/iu;
    const withdrawn = (observation, after) => {
        const quote = /^\s*[“"‘']/u.test(observation);
        const resultReferent = '(?:values?|results?|estimates?|measurements?|observations?|probabilities|probability|coefficients?|proportions?|improvements?|correlations?|(?:rejection\\s+)?rates?)';
        const revoked = new RegExp(`\\b(?:these|those|this|that|the\\s+above)\\s+${resultReferent}\\b[^.;!?]{0,70}\\b(?:(?:not|never)\\b[^.;!?]{0,30}\\b(?:measured|observed|reported|obtained|produced)|withdrawn|retracted|fabricated|false|incorrect)\\b|\\bneither\\s+${resultReferent}\\b[^.;!?]{0,40}\\b(?:measured|observed|reported|obtained|produced)\\b|\\b(?:this|that|the\\s+above)\\s+(?:claim|statement|evaluation|experiment|test)\\b[^.;!?]{0,60}\\b(?:false|incorrect|fabricated|retracted|withdrawn|(?:not|never)\\s+(?:(?:been|actually|yet)\\s+)*(?:performed|conducted|carried\\s+out|true))\\b|\\bthis\\s+(?:is|was)\\s+(?:(?:only|just|merely)\\s+)?(?:a\\s+|an\\s+)?(?:synthetic|hypothetical|illustrative|fictional)\\b`, 'iu');
        return quote || revoked.test(observation) || revoked.test(after.slice(0, 180));
    };
    const number = '[-+]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)';
    const lines = String(sourceText || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        if (!/\bTable\s+[0-9]+\s*:\s*(?:Performance|Comparison|Evaluation|Ablation|Results)\b/iu.test(lines[index])
            || denied.test(lines[index]) || denied.test(lines.slice(Math.max(0, index - 2), index).join(' '))) continue;
        const block = [];
        for (let next = index + 1; next < Math.min(lines.length, index + 50); next++) {
            if (/\bTable\s+[0-9]+\s*:/iu.test(lines[next])) break;
            block.push(lines[next]);
        }
        // These named result columns are not generic "score"/"metric" labels.
        // Rows must literally follow that header with the same complete width.
        const betaHeader = /\b(?:Cue|Feature|Predictor)\s+([A-Za-z][A-Za-z0-9_-]*)\s*β\s+([A-Za-z][A-Za-z0-9_-]*)\s*β/u;
        const header = block.findIndex(line => /\bModel\s+Rm\s+Rstd\s+Rpos\s+Spec\s+F1pos\b/u.test(line)
            || /\bMethods\s+JS↓\s*BC↑\s*R[2²]↑\s*Brier↓/u.test(line) || betaHeader.test(line));
        if (header < 0) continue;
        const beta = betaHeader.exec(block[header]);
        if (beta) {
            const headerText = block.slice(0, header).join(' ');
            const definition = /\b(?:importance|effects?)\s+is\s+measured\s+by\s+the\s+fixed-effect[\s\S]{0,160}?coefficient\s*\(β\)\s+from\s+the\s+mixed-effects\s+models\b/iu.exec(headerText);
            // Framing before the measurement declaration belongs to this table.
            // Afterwards, reject explicit attribution of these coefficients, not
            // unrelated discussion from the other column of a PDF page.
            const coefficientFraming = /\b(?:these|those|following|above)\s+(?:values|coefficients)\b[^.;!?]{0,70}\b(?:hypothetical|illustrative|fictional|synthetic|prior|previous|quoted)\b|\b(?:hypothetical|illustrative|fictional|synthetic)\s+(?:values|coefficients)\b|\b(?:prior|previous|earlier|another)\s+(?:study|paper|work)\b[^.;!?]{0,70}\b(?:following|these|those)\s+(?:values|coefficients)\b/iu;
            if (!definition || denied.test(headerText.slice(0, definition.index + definition[0].length))
                || coefficientFraming.test(block.join(' ')) || beta[1].toLowerCase() === beta[2].toLowerCase()) continue;
        } else if (denied.test(block.slice(0, header + 1).join(' '))) continue;
        const width = beta ? 2 : /\bF1pos\b/u.test(block[header]) ? 5 : 4;
        const rowPattern = new RegExp(`^\\s*([A-Za-z][A-Za-z0-9 ()+_.-]{0,70}?)\\s+((?:${number}\\s+){${width - 1}}${number})\\s*$`, 'u');
        const rows = []; let lastRow = header;
        for (let offset = header + 1; offset < block.length; offset++) {
            const line = block[offset];
            const row = rowPattern.exec(line);
            if (row && row[2].trim().split(/\s+/u).every(value => Number.isFinite(Number(value))
                && (beta || Number(value) >= 0 && Number(value) <= 1))) {
                rows.push(row[1].trim()); lastRow = offset;
            }
        }
        if (new Set(rows).size >= 2 && !withdrawn(`${lines[index]} ${block.slice(0, lastRow + 1).join(' ')}`,
            block.slice(lastRow + 1).join(' ').slice(0, 180))) return true;
    }
    const metric = '(?:recognition\\s+accuracy|mean\\s+silhouette(?:\\s+coefficient)?|centroid\\s+size|AUC)';
    const scalar = new RegExp(`\\b(${metric})\\b\\s*(?:averag(?:ing|ed|es?)|varied\\s+by\\s+actor:|exceeded|=|of|at)\\s*(${number})(%?)(?![A-Za-z0-9_.%])`, 'iu');
    for (const paragraph of paragraphs) {
        for (const correlation of paragraph.matchAll(/\bwe\s+(?:observe|observed|measured)\b[\s\S]{0,160}?\b(?:average|mean)\s+correlation\s+(?:of|=)\s*([-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.%])/giu)) {
            const after = paragraph.slice(correlation.index + correlation[0].length, correlation.index + correlation[0].length + 180);
            const local = paragraph.slice(Math.max(0, correlation.index - 250), correlation.index + correlation[0].length) + after;
            if (Number(correlation[1]) >= -1 && Number(correlation[1]) <= 1 && !denied.test(local)
                && /\binter[- ]model\b[\s\S]{0,70}\bcorrelation\s+(?:matrix|matrices)\b/iu.test(local)
                && /\bamong\s+[A-Z][A-Za-z0-9_+-]{1,40}/u.test(after)
                && /\b(?:architectures|models|systems)\b/iu.test(local)
                && !withdrawn(local, after)) return true;
        }
        const ratePair = new RegExp(`\\brejection\\s+rates\\b[\\s\\S]{0,100}\\bshows\\b[\\s\\S]{0,120}?\\bapproximately\\s+(${number})\\s+percentage\\s+points\\s+under\\s+(?:the\\s+)?([A-Za-z-]+(?:\\s+[A-Za-z-]+){0,4}\\s+(?:model|analysis))[\\s\\S]{0,180}?\\band\\s+(${number})\\s+points\\s+under\\s+(?:the\\s+)?([A-Za-z-]+(?:\\s+[A-Za-z-]+){0,4}\\s+(?:model|analysis))`, 'gu');
        for (const rate of paragraph.matchAll(ratePair)) {
            const local = paragraph.slice(Math.max(0, rate.index - 250), rate.index + rate[0].length);
            if (!denied.test(local) && /\bcalibrated\b/iu.test(local)
                && /\b(?:empirical|observed|measured|results\s+confirm)\b/iu.test(local)
                && [rate[1], rate[3]].every(value => Math.abs(Number(value)) <= 100)
                && rate[2].toLowerCase().replace(/\s+/gu, ' ') !== rate[4].toLowerCase().replace(/\s+/gu, ' ')
                && !withdrawn(local, paragraph.slice(rate.index + rate[0].length, rate.index + rate[0].length + 180))) return true;
        }
        for (const proportion of paragraph.matchAll(/\b(?:Our|This)\s+study\s+(?:shows|showed|found|observed)\s+(?:a\s+)?(?:(?:high|low)\s+)?incidence\b[\s\S]{0,240}?\bwith\s+([0-9]+(?:\.[0-9]+)?)%\s+of\s+all\s+[A-Za-z][A-Za-z0-9_-]{1,35}\s+(?:having|showing|exhibiting)\s+[^.;]{2,80}/gu)) {
            const local = paragraph.slice(Math.max(0, proportion.index - 160), proportion.index + proportion[0].length);
            if (Number(proportion[1]) > 0 && Number(proportion[1]) <= 100 && !denied.test(local)
                && !CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.test(proportion[0])
                && !/\b(?:gpus?|cpus?|tpus?|npus?|layers?|parameters?|batches|epochs?|steps?)\b/iu.test(proportion[0])
                && /\b(?:in|on|for|among)\b/iu.test(proportion[0])
                && !withdrawn(local, paragraph.slice(proportion.index + proportion[0].length, proportion.index + proportion[0].length + 180))) return true;
        }
        for (const contrast of paragraph.matchAll(/\bresult(?:ing|ed)\s+in\s+(?:up\s+to\s+)?([0-9]+(?:\.[0-9]+)?)\s*×\s+(?:worse|better|higher|lower)\s+(?:jailbreak|attack)(?:\s+success)?\s+rates?\s+than\s+(?:the\s+)?(?:unimodal|baseline|control|reference)\b/gu)) {
            const local = paragraph.slice(Math.max(0, contrast.index - 300), contrast.index + contrast[0].length);
            if (Number(contrast[1]) > 1 && !denied.test(local)
                && /\bwe\s+(?:showed|observed|found|demonstrated)\b/iu.test(local)
                && !withdrawn(local, paragraph.slice(contrast.index + contrast[0].length, contrast.index + contrast[0].length + 180))) return true;
        }
        // An estimated group effect is not its participant count or a free p
        // value. The observed contrast must precede a coefficient + p-value.
        for (const estimate of paragraph.matchAll(/\((?:β|Est\.?)\s*=\s*([-+]?[0-9]+(?:\.[0-9]+)?),\s*(?:SE\.?\s*=\s*[0-9]+(?:\.[0-9]+)?,\s*t\s*=\s*[-+]?[0-9]+(?:\.[0-9]+)?,\s*)?p\s*[<=]\s*(0\.[0-9]+)\)/gu)) {
            const local = paragraph.slice(Math.max(0, estimate.index - 300), estimate.index + estimate[0].length);
            if (!denied.test(local)
                && !withdrawn(local, paragraph.slice(estimate.index + estimate[0].length, estimate.index + estimate[0].length + 180))
                && /\b(?:speakers?|participants?|patients?|subjects?|groups?)\b(?:[^.;!?]|\.(?=[0-9])){0,200}\b(?:had|exhibited|showed)\b(?:[^.;!?]|\.(?=[0-9])){0,120}\b(?:higher|lower|greater|smaller|increased|decreased)\b/iu.test(local)
                && Number(estimate[2]) > 0 && Number(estimate[2]) < 1) return true;
        }
        for (const posterior of paragraph.matchAll(/\bin\s+[A-Z][A-Za-z-]{1,35}\s*\(95%\s*CrI:\s*\[([-+]?[0-9]+(?:\.[0-9]+)?),\s*([-+]?[0-9]+(?:\.[0-9]+)?)\],\s*ER\s+for\s+[^:()]{1,35}:\s*([0-9]+(?:\.[0-9]+)?)\)/gu)) {
            const local = paragraph.slice(Math.max(0, posterior.index - 400), posterior.index + posterior[0].length);
            if (!denied.test(local) && !withdrawn(local, paragraph.slice(posterior.index + posterior[0].length, posterior.index + posterior[0].length + 180))
                && /\bshowed\b[^.;]{0,100}\bassociation\b/iu.test(local)
                && Number(posterior[1]) <= Number(posterior[2])) return true;
        }
        const statements = paragraph.replace(/\bet al\.(?=\s)/giu, 'et al').split(/(?<=[.!?])\s+/u);
        for (let index = 0; index < statements.length; index++) {
            const statement = statements[index];
            const framing = statements[index - 1] || '';
            if (denied.test(framing) && /\b(?:following|below|next|these|this|test|experiment|evaluation)\b/iu.test(framing)) continue;
            if (statement.length <= 1800 && !denied.test(statement)
                && !withdrawn(statement, statements[index + 1] || '')) {
                const match = scalar.exec(statement);
                const value = match && Number(match[2]);
                const validValue = match && Number.isFinite(value) && (/centroid/i.test(match[1]) ? value > 0
                    : /silhouette/i.test(match[1]) ? value >= -1 && value <= 1
                        : value >= 0 && value <= (match[3] === '%' ? 100 : 1));
                if (validValue && /\b(?:showed|yield(?:s|ed)?|averag(?:ing|ed|es?)|varied|found|demonstrate[sd]?|exceeded)\b|\b(?:optimal\s+)?solution\s+was\b/iu.test(statement)
                    && /\b(?:compared\s+to|than|against|versus|baseline|chance|classification|clustering|actor|speakers?|males?|females?|models?|systems?|methods?|groups?|conditions?|evaluations?)\b/iu.test(statement)) {
                    return true;
                }
                const paired = new RegExp(`\\b(?:Both|The\\s+models?)\\s+([A-Za-z][A-Za-z0-9_+-]{1,35})\\s+and\\s+([A-Za-z][A-Za-z0-9_+-]{1,35})\\s+(?:yield|yielded|achieved|produced)\\s+CKA\\s+scores\\b[^()]{0,45}\\((${number})\\s+and\\s+(${number}),\\s*respec-?\\s*tively\\)`, 'iu').exec(statement);
                if (paired && paired[1].toLowerCase() !== paired[2].toLowerCase()
                    && [paired[3], paired[4]].every(value => Number(value) >= 0 && Number(value) <= 1)) return true;
            }
            // The same evaluated system, one probability variable, two explicit
            // input conditions and an observed directional change. P(x)=... by
            // itself, priors and probability-distribution definitions cannot pass.
            const candidate = statements.slice(index, index + 3).join(' ');
            const probabilities = [...candidate.matchAll(/\bP\(([A-Za-z][A-Za-z0-9_]*)\)\s*=\s*(0(?:\.[0-9]+)?|1(?:\.0+)?)(?![A-Za-z0-9_.%])/gu)];
            if (probabilities.length !== 2) continue;
            const window = candidate;
            const models = new Set([...window.matchAll(/\b([A-Z][A-Za-z0-9_+.-]{1,40})\s+(?:model|system)\b|\b(?:model|system)\s+([A-Z][A-Za-z0-9_+.-]{1,40})/gu)]
                .map(match => (match[1] || match[2]).toLowerCase()).filter(value => !['the', 'this', 'that', 'different'].includes(value)));
            if (window.length > 1500 || denied.test(window)
                || models.size !== 1
                || withdrawn(window, statements[index + 3] || '')
                || !/\b(?:evaluation|test)\b[^.;]{0,80}\b(?:demonstrated|performed|conducted)\b[^.;]{0,80}\b(?:model|system)\b/iu.test(window)
                || !/\b(?:isolated|single|univariate|baseline)\b[^.;]{0,150}\b(?:triggers?|yield(?:s|ed)?|produces?)\b/iu.test(window)
                || !/\b(?:recombin\w*|combin\w*|modified|perturbed)\b[^.;]{0,200}\b(?:shifting|shifted|decreasing|decreased|increasing|increased)\b/iu.test(window)) continue;
            if (probabilities[0][1] === probabilities[1][1]
                && Number(probabilities[0][2]) !== Number(probabilities[1][2])) return true;
        }
    }
    return false;
}

function classifyGenericSourceQuantitativeEvidence(sourceText, sentences = null) {
    if (!sourceText) return null;
    if (sourceHasMeasuredMetricTable(sourceText) || sourceCorpusCurationResult(sourceText)
        || sourceHasObservedOutcomeComparison(sourceText)) return true;
    const values = Array.isArray(sentences) ? sentences : String(sourceText).trim()
        .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/)
        .map(sentence => sentence.trim()).filter(Boolean);
    return values.some((sentence, index) => {
        if (!hasCoreSummaryQuantitativeEvidence(sentence)) return false;
        const localContext = values.slice(Math.max(0, index - 1), Math.min(values.length, index + 2)).join(' ');
        return /(?:experiment|evaluation|result|benchmark|test set|dataset|table|metric|实验|评测|结果|基准|测试集|数据集|表格|指标)/i
            .test(localContext)
            // 听测结果须明确本方法、实测指标和已发生的数值变化。
            // 人数、量表、音频时长、预测及转述的旧工作不能用这条规则通过。
            || /^In (?:a|our) listening study\b[^,.;]{0,100},\s*(?:our|the proposed|this|region[- ]aware)\s+(?:method|model|system|approach|masking)\s+(?:reduces?|lowers?|improves?|increases?)\s+(?:the\s+)?(?:perceived\s+accent|accent\s+(?:ratings?|scores?))\s+from\s+[+-]?\d+(?:\.\d+)?\s+to\s+[+-]?\d+(?:\.\d+)?\b/i.test(sentence)
                && /\b(?:baseline|control|reference)\b/i.test(sentence)
            || hasCoreSummaryStatisticalResult(sentence)
                && /\b(?:adjusted|mixed[- ]effects?|count\s+models?|interaction|groups?)\b|调整后|计数模型|交互项|组别/i.test(localContext);
    }) || hasSourceMeasuredLossComparison(values);
}

function classifySourceQuantitativeEvidence(sourceText, sentences = null) {
    const generic = classifyGenericSourceQuantitativeEvidence(sourceText, sentences);
    return generic === true || sourceSoftwareFunctionalValidationResult(sourceText) ? true : generic;
}

function stripDuplicatedLineFootnoteMarkers(text) {
    return String(text || '').replace(
        /([^\d\r\n])[ \t]+(\d{1,3})\r?\n[ \t]*(\d{1,3})[ \t]*(?=\r?\n|$)/g,
        (match, preceding, inline, standalone) => (
            inline === standalone || inline === `${standalone}${standalone}` ? preceding : match
        )
    );
}

// 这些组合只声明当前句的实测条件，不能替代结果指标或比较方向。
function hasConcreteCoreSummarySetting(sentence) {
    if (/(?:假设|如果|若在|预计|预期|可能|未在|没有|未进行|未做|不进行|不做)/.test(sentence)) return false;
    const affirmedSetting = !/(?:讨论|提及|并非|不是|不能|假想|设想|计划|未来|无关|文件目录|否认|反驳|引用|引述)/u.test(sentence);
    const languageNamedDataset = affirmedSetting && /(?:在|于)(?:[\u4e00-\u9fff]{1,8}语)\s*[A-Z][A-Za-z0-9._-]{2,}(?:上|中)/u.test(sentence);
    const heldOutConversations = affirmedSetting && /(?:在|于)\s*每(?:模型|权重)\s*[1-9][0-9]*\s*组(?:留存|留出)对话(?:上|中)/u.test(sentence);
    const syntheticSetting = /(?:在|于)\s*\d+\s*(?:组|个)\s*(?:随机|随机采样的|随机采样)\s*(?:双衰减|多衰减|房间脉冲响应|混响时间|声源位置|声学房间)\s*合成配置(?:上|中)/.test(sentence);
    const speakerSplit = /(?:在|于)\s*说话人(?:互斥|不重叠)的\s*[A-Z][A-Za-z0-9._-]{2,}\s*(?:语料)?实测(?:中|上)/.test(sentence);
    const timedHardware = /(?:在|于)\s*(?:Raspberry\s+Pi|Jetson|MacBook|Intel|AMD|NVIDIA|Apple|CPU|GPU)(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,3}\s+[A-Za-z]{0,4}\d+[A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,2}\s*上/.test(sentence)
        && /(?:计时|耗时|时延|延迟|推理时间|运行时间|预处理时间)/.test(sentence);
    const namedRequestEvaluation = !/(?:讨论|提及|并非|不是|不能|假想|设想|假设|预计|预期|可能|计划|未来|无关|文件目录)/u.test(sentence) && /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9._-]{1,39}-Bench(?![A-Za-z0-9_])全部\s*[1-9][0-9]*个请求的评估中/iu.test(sentence);
    const heldOutSpeakerComparison = !/(?:讨论|提及|并非|不是|不能|假想|设想|假设|预计|预期|可能|计划|未来|无关|文件目录)/u.test(sentence) && /(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*标准(?:[1-9][0-9]*|[一二两三四五六七八九十]+)名留出说话人[^，,。！？!?；;\n]{0,100}比较中/u.test(sentence);
    const experimentScope = /(?:在|于)[^，,。！？!?；;\n]{1,150}(?:实验|测量)(?:中|上)/u.exec(sentence);
    const formatScope = /(?:在|于)([^，,。！？!?；;\n]{1,110}(?:语音|音频|音乐))(?:上|中)/u.exec(sentence);
    const scopes = [experimentScope && /[1-9][0-9]{0,5}\s*名[^，,。！？!?；;\n]{0,45}(?:参与者|听者|受试者|母语者|说话人)/u.test(experimentScope[0]) && /(?:聆听|听辨|听测|主观|重复)[^，,。！？!?；;\n]{0,45}实验/u.test(experimentScope[0]) ? experimentScope : null, /(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*(?:匹配|失配|跨域|未见说话人)测试[^，,。！？!?；;\n]{0,60}(?:下|中|上)/u.exec(sentence),
        formatScope && /采样/u.test(formatScope[1]) && /(?:[1-9][0-9]{0,2}|[一二两三四五六七八九十百]{1,5})位/u.test(formatScope[1]) && /[0-9]+(?:\.[0-9]+)?\s*(?:kHz|Hz)(?![A-Za-z])/u.test(formatScope[1]) ? formatScope : null].filter(Boolean);
    const measuredNaturalSetting = !/(?:假设|假想|假定|设想|如果|若|是否|预计|预期|可能|计划|未来|讨论|提及|并非|不是|不能|未进行|未测|未报告|没有|将(?:会|要)?(?:在|于))/u.test(sentence) && scopes.some(scope => {
        let previousMetricHeader = false;
        for (const raw of sentence.slice(scope.index + scope[0].length).split(/[，,；;]/u)) {
            const clause = raw.trim();
            const metric = [CORE_SUMMARY_METRIC_PATTERN, CORE_SUMMARY_CONFERENCE_METRIC_PATTERN].some(pattern => {
                const matches = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
                return [...clause.matchAll(matches)].some(match => /^(?:(?:指标|分数|得分))?(?:(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|下(?:有|无)[^，,；;。]{1,24}(?:刺激|条件)(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])/iu.test(clause.slice(match.index + match[0].length)));
            });
            if (/(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分|x|×))?(?![A-Za-z0-9_.])/iu.test(clause) && !/(?:参数(?:量|值|个数)?|学习率|批量|批大小|样本(?:量|数)|训练|推理|部署|迭代|步数|轮数|GPU|CPU|显存|内存|硬件|时长|小时|batch)/iu.test(clause)
                && (metric || (previousMetricHeader && /^(?:(?:本方法|本文方法|所提方法|提出的方法|本系统|该方法|该系统)(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|[A-Z][A-Za-z0-9_-]{1,40}(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?\s*(?:%|％|dB|ms|s|秒|分钟|倍|点|分|x|×)(?![A-Za-z0-9_])|(?:元音|辅音|鼻音|擦音|音段)\s*`?\/[A-Za-z]+\/`?(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])/iu.test(clause)))) return true;
            previousMetricHeader = new RegExp(`^(?:以|用)(?:${CORE_SUMMARY_METRIC_PATTERN.source}|${CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.source})(?:计|衡量)$`, 'iu').test(clause);
        }
        return false;
    });
    return languageNamedDataset || heldOutConversations
        || syntheticSetting || speakerSplit || timedHardware || namedRequestEvaluation || heldOutSpeakerComparison || measuredNaturalSetting;
}

function hasRecordedDissonanceComparison(sentence) {
    if (/(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))/u.test(sentence)) return false;
    if (!/(?:在|于)[^，,。！？!?\n]{1,100}(?:录音|听辨|听测|实验|测试)(?:比较|评测)?中/u.test(sentence)) return false;
    const pair = /(?:塞萨里斯|Sethares)\s*(?:感觉)?不协和度(?:从|由)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?\s*(增至|升至|降至|减至)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?(?=\s*(?:[，,；;]|$))/iu.exec(sentence);
    return Boolean(pair && (/(?:增|升)至/u.test(pair[2])
        ? Number(pair[3]) > Number(pair[1]) : Number(pair[3]) < Number(pair[1])));
}

function hasMeanRoomSimulationComparison(sentence) {
    if (/(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))/u.test(sentence)) return false;
    const context = /(?:在|于)([^，,。！？!?\n]{1,120})上(?:按|以)\s*[1-9]\d*\s*个房间平均(?:的)?(?:单房间)?(?:平均)?空间房间脉冲响应仿真耗时/u.exec(sentence);
    if (!context || !/(?:Apple|MacBook|Intel|AMD|NVIDIA|CPU|GPU|Jetson|Raspberry)/iu.test(context[1])) return false;
    const values = [...sentence.matchAll(/(?:镜像源)?([1-9]\d*)阶\s*(\d+(?:\.\d+)?)\s*(秒|毫秒|s|ms)(?![A-Za-z\d.])/giu)];
    if (values.length < 2 || new Set(values.map(value => value[1])).size !== values.length
        || values.some(value => Number(value[2]) <= 0)) return false;
    const seconds = new Map(values.map(value => [value[1], Number(value[2]) * (/^(?:毫秒|ms)$/i.test(value[3]) ? 0.001 : 1)]));
    const comparison = /([1-9]\d*)阶(?:明显)?(高于|低于)([1-9]\d*)阶(?:和([1-9]\d*)阶)?(?![\d.])/u.exec(sentence);
    if (!comparison) return false;
    const compared = [comparison[3], comparison[4]].filter(Boolean);
    return seconds.has(comparison[1]) && compared.every(order => seconds.has(order)
        && (comparison[2] === '高于' ? seconds.get(comparison[1]) > seconds.get(order)
            : seconds.get(comparison[1]) < seconds.get(order)));
}

function coreSummaryQuantitativeResultState(text) {
    const candidates = String(text || '').split(/[。！？!?\n]/).map((rawSentence, sentenceIndex) => {
        const sentence = stripCoreSummaryNonResultNumerals(rawSentence.trim());
        // CLAP 既可能指指标，也可能指对照模型。写明 model/baseline
        // 不能顶替缺失的结果指标。
        const metricText = sentence.replace(/(?:\bCLAP\s*(?:基线|模型|baseline\b|model\b)|\bNLL\s*(?:基线|模型|方法|baseline\b|model\b|method\b)|(?<![A-Za-z0-9_])(?:TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S)\s*(?:基线|模型|方法|baseline\b|model\b|method\b))/giu, '');
        const hasRecognizedMetric = Boolean(sentence && (
            CORE_SUMMARY_METRIC_PATTERN.test(metricText)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(metricText)
            || hasCoreSummaryStatisticalResult(metricText)
        ));
        const numbers = sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        const hasDirection = Boolean(sentence
            && hasCoreSummaryComparisonDirection(sentence, numbers));
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
            || hasNamedSetting || /(?<![A-Za-z0-9_])[1-9][0-9]*[A-Za-z][A-Za-z0-9._-]{0,39}-(?:Bench|Benchmark)(?![A-Za-z0-9_])(?:上|中|下)/i.test(rawSentence) || hasTimedNamedSplit || hasConcreteCoreSummarySetting(sentence)
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

function hasBlockLayoutProductChain(summary) {
    // 布局、筛出的键块和内核必须在同句真实交接，不能只罗列组件名。
    return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence => {
        if (sentence.length > 320 || /(?:讨论|提及|不实现|尚不|不负责|不参与|不承担|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|设想|如果|若|可能|预计|计划|未来|建议)|(?:不|未)(?:曾|实际|直接|真正|会|能)*\s*(?:进入|计算|筛选|补充|恢复)/u.test(sentence)) return false;
        return /(?:该|此)布局(?:经[^，,。；]{1,16}(?:置换|重排))?进入查询块与键块筛选[，,]\s*以块(?:级)?均值特征计算块分数并用混合Top-k与Top-p为[^，,。；]{1,30}补充键块[，,]\s*选中键块进入稀疏注意力内核计算(?:再|并)经逆置换恢复原序/u.test(sentence);
    });
}

function hasPosteriorUpdateProductChain(summary) {
    // 当前模型先产生后验功率，再把同一产物交给参数更新。
    return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence =>
        sentence.length <= 320
        && !/(?:假定|是否|讨论|提及|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|如果|可能|计划|未来)|(?:不|未)(?:曾|实际|直接|真正|确实|被)*\s*(?:算出|计算|进入|更新)/u.test(sentence)
        && /由当前模型方差(?:算出|计算)(?:成分占模型方差的)?贡献比与后验功率[，,]\s*(?:该|此)后验功率作为固定输入进入同一成分的幅度与衰减率更新/u.test(sentence));
}

function hasConcreteProductHandoff(summary) {
    // Typed, ordered producer/consumer handoffs. Do not count module names or
    // action words alone, and do not stitch unrelated paragraphs together.
    const sentences = String(summary || '').replace(/（[^）]*）|\([^)]*\)/gu, '')
        .split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:假设|设想|假定|如果|可能|未来|拟采用|计划|预计|预期|应当|应该|并非|并未|没有|不能|尚未|未曾|另一(?:种|套)|独立方法|讨论|提及|对比|比较|相关工作|先前工作|文献|未(?:实现|执行|实施)|不负责|不用于|不与|未与)|(?:^|[。；，,])\s*建议|(?:不|未)(?:被|曾|直接|实际|真正|会|能|再)*\s*(?:生成|输出|预测|提取|抽取|转成|送入|配对|拼接|作用于|统计|计算|重建|合并)/u;
    const neuralTokens = /解码器[^。；]{0,140}(?:预测|输出|生成)(?:源内容对应的)?(?:离散)?声学令牌[^。；]{0,140}(?:所得|这些|该)(?:声学)?令牌(?:再)?送入(?:神经音频)?编解码器(?:解码器)?(?:重建|解码)(?:为|成)?波形/u;
    const frameProduction = /编码器[^。；]{0,120}(?:输出|转成|提取|抽取)(?:为|成)?帧级(?:编码)?表示/u;
    const frameConsumption = /听众嵌入[^。；]{0,100}与(?:每帧编码|帧级(?:编码)?表示)拼接[，,]\s*拼接序列送入[^。；]{0,45}(?:长短期记忆网络|BiLSTM|回归头)[^。；]{0,20}(?:得到|输出|预测)帧级分数/u;
    const maskProcessing = /(?:录音|清洁语音|干净语音)[^。；]{0,90}(?:生成|得到)二值时频掩码[，,]\s*(?:再|随后)?(?:(?:将|把)(?:该|所得)?(?:二值时频)?掩码)?作用于[^。；]{0,60}统计(?:语音帧与噪声帧|语音与噪声)(?:的)?功率[^。；]{0,70}(?:算出|计算)[^。；]{0,50}信噪比/u;
    const textProduction = /问答[^。；]{0,70}以[^。；]{0,50}为输入(?:转成|重构成)一问一答[^。；]{0,100}整体反馈[^。；]{0,90}合并成[^。；]{0,60}辅导文本/u;
    const textConsumption = /两类文本[^。；]{0,35}与对应录音配对[^。；]{0,100}指令微调/u;
    for (let i = 0; i < sentences.length; i++) {
        for (const size of [1, 2]) {
            const parts = sentences.slice(i, i + size);
            if (parts.length !== size || parts.some(s => s.length > 320)) continue;
            const window = parts.join('。');
            if (denied.test(window)) continue;
            if (!/(?:若|假想|假定|设想|是否|相互独立|无关(?:的)?(?:波形|方法))|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:回归|预测|输出|求|计算|得到)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:不|未|没有)(?:再|实际|直接|继续)?(?:使用|采用|处理|传递|送入)(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:丢弃|弃用)(?:了)?(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:不|未|没有)(?:再|实际|直接|继续)?(?:将|把)(?:该|此|所得)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:送入|用于|交给)/u.test(window) && /(?:编码器|解码器|网络)[^。；]{0,180}(?:回归|预测|输出)(?:估计的)?(?:基频)?波形/u.test(parts[0])
                && /(?:由|将|把)(?:该|此|估计得到的)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:求|计算|得到)解析信号并(?:计算|求取)相位导数(?:即得|得到)(?:瞬时频率|连续基频)/u.test(parts.at(-1))) return true;
            if (neuralTokens.test(window) || maskProcessing.test(window)
                || (frameProduction.test(parts[0]) && frameConsumption.test(parts.at(-1)))
                || (textProduction.test(parts[0]) && textConsumption.test(parts.at(-1)))) return true;
        }
    }
    return false;
}

// Shared grammar. No paper/model/benchmark names are accepted here.
function hasExplicitArtifactHandoff(summary) {
    const sentences = String(summary || '').replace(/（[^）]*）|\([^)]*\)/gu, '')
        .split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
    const denied = /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|讨论|提及|并非|不是|没有|未曾|尚未|独立方法|无关)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:生成|输出|得到|形成|取出|提取|编码|使用|接收|承接|送入|进入|作为|用于|计算|分成|分派)/u;
    const production = /(?:生成|得到|输出|形成|统一为|压缩为|池化得|取出|提取|抽取)/u;
    const processing = /(?:修复|合成|重采样|预处理|构造|编码|池化|变换|搬移|变频|检测器|分类头)/u;
    const consumerAction = /(?:分成|分派|编码|计算|训练|学习|分类|回归|去噪|评分|解码|重合成)/u;
    const artifacts = [
        {names:/(?:刺激)?语音/gu, same:'(?:刺激)?语音'},
        {names:/配对(?:监督)?信号/gu, same:'配对(?:监督)?信号'},
        {names:/(?:双|两)视图/gu, same:'(?:双|两)视图'},
        {names:/(?:utterance|输入)?嵌入/gu, same:'(?:utterance|输入)?嵌入'},
        {names:/(?:数值|定长|固定维数)?向量/gu, same:'(?:数值|定长|固定维数)?向量'}
    ];
    for (let index = 0; index < sentences.length; index++) {
        const first = sentences[index], second = sentences[index + 1] || '';
        if (first.length > 320 || second.length > 320) continue;
        // A measured rollout hands an explicitly enumerated behavioral output
        // to scoring. It is a benchmark process, without invented model modules.
        if (!denied.test(first) && /(?:预载|载入)[^。]{1,80}(?:历史|上下文)[^。]{0,60}(?:实时流入|逐帧处理|滚动输入)[^。]{0,50}(?:该|此)阶段产生的[^。]{1,80}(?:、|与|和)[^。]{1,60}直接进入评分/u.test(first)) return true;
        for (const family of artifacts) {
            family.names.lastIndex = 0;
            for (const artifact of first.matchAll(family.names)) {
                const before = first.slice(0, artifact.index);
                const immediate = before.split(/[，,]/u).at(-1);
                // Production can use the role in an earlier same-sentence
                // clause, but never borrow an actor from another sentence.
                if (!production.test(immediate) || !processing.test(before) || denied.test(before)) continue;
                const productTail = first.slice(artifact.index + artifact[0].length);
                const following = productTail + (second ? '。' + second : '');
                const aliases = family.same;
                const localReference = new RegExp(`(?:该|这些|上述|所得|取出的|得到的|形成的)(?:每个|每一|输入)?${aliases}[^，,。]{0,65}`, 'u');
                const count = /([1-9][0-9]{0,5})\s*(?:段|个|条|维|种)?\s*$/.exec(immediate);
                const countReference = count ? new RegExp(`${count[1]}\\s*(?:段|个|条|种)?${aliases}[^，,。]{0,65}`, 'u') : null;
                const viewReference = /^(?:双|两)视图$/u.test(artifact[0]) ? /两视图[^，,。]{0,65}/u : null;
                const references = [localReference, countReference, viewReference].filter(Boolean);
                if (references.some(pattern => {
                    const used = pattern.exec(following);
                    if (!used) return false;
                    const preceding = following.slice(Math.max(0, used.index - 20), used.index);
                    return !denied.test(preceding + used[0]) && consumerAction.test(used[0]);
                })) return true;
                // Immediate ellipsis belongs only to the just-produced artifact;
                // an unrelated output or an unowned pronoun cannot satisfy this.
                if (/^[，,]\s*直接作为[^，,。]{0,20}(?:分类器|回归器|解码器|编码器)输入/u.test(productTail)
                    && !denied.test(productTail.split(/[。；]/u)[0])) return true;
                // Explicit reception may precede the repeated artifact name.
                const received = new RegExp(`(?:训练时)?承接该${aliases}[^。]{0,180}`, 'u').exec(second);
                if (received && !denied.test(received[0]) && /(?:分支|模型|网络)[^。]{0,140}(?:学习|训练|去噪)/u.test(received[0])) return true;
            }
        }
    }
    return false;
}

// A concrete cached state producer and its adjacent causal consumer.
function hasCachedCausalStateHandoff(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|独立方法|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾|否认|否定|反驳|驳斥|引用|引述|转述)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:压缩|形成|生成|输出|缓存|使用|消费|建模|读取|接收)|(?:丢弃|弃用|忽略)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u;
    for (let i = 0; i + 1 < sentences.length; i++) {
        const first = sentences[i], second = sentences[i + 1];
        if (first.length > 320 || second.length > 320 || denied.test(first) || denied.test(second)) continue;
        // The vector must explicitly become the cached causal state sequence.
        if (!/编码器[^。；]{0,100}(?:压缩|汇聚|编码)为\s*(?:\d+\s*维)?向量[，,]\s*(?:形成|生成|得到)因果状态序列(?:并|[，,])缓存(?:供|用于)后续(?:时序)?建模(?:使用)?/u.test(first)) continue;
        // An adjacent causal temporal model actually models the same state product.
        if (/^(?:该|此)?因果(?:Conformer|Transformer|时序模型|时序网络)(?:沿|基于|使用)[^，,。；]{0,35}历史建模(?:该|此|这些)?状态(?:演变|序列)并(?:输出|预测|给出)(?:帧级|起始|事件|发生)?风险/u.test(second)) return true;
    }
    return false;
}

// A measured offline operating point has a concrete false-warning burden AND
// explicitly lacks inference/deployment measurements. Cost absence alone fails.
function hasOfflineOperationalBoundary(summary) {
    const sentences = String(summary || '').split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾|否认|否定|反驳|驳斥|引用|引述|转述)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u;
    const overclaim = /(?:证明|证实|验证|确认)[^。；]{0,25}(?:临床|干预|实际部署|在线部署)[^。；]{0,25}(?:有效|有效性|效果|可行|成功)|(?:已|已经|完成)[^。；]{0,12}(?:临床|干预|实际部署|在线部署)[^。；]{0,15}(?:验证|有效|成功)/u;
    // A contradictory claim elsewhere cannot be masked by a qualifying sentence.
    if (overclaim.test(String(summary || ''))) return false;
    return sentences.some(sentence => {
        if (sentence.length > 600 || denied.test(sentence)
            || /(?:不|未)(?:曾|实际|真正|直接|仅|只|能|会)*在[^。；]{0,100}离线(?:仿真|模拟)评估/u.test(sentence)) return false;
        if (!/在[^。；]{1,100}离线(?:仿真|模拟)评估中[，,]/u.test(sentence)) return false;
        const operation = /\d+(?:\.\d+)?%报警占空比下[^，,。；]{1,40}(?:事件覆盖率|召回率|敏感性)\s*\d+(?:\.\d+)?%/u.test(sentence);
        const burden = /验证集[^。；]{0,30}阈值下[^。；]{0,90}但每分钟(?:有|产生)\s*\d+(?:\.\d+)?\s*(?:个|次)?误报(?:段|警报|报警)/u.test(sentence);
        const missingMeasurement = /原文(?:未报告|未披露)[^。；]{0,20}推理延迟(?:与|和|及)实际部署开销/u.test(sentence);
        return operation && burden && missingMeasurement;
    });
}

function hasNaturalScopedBoundary(summary) {
    if (hasOfflineOperationalBoundary(summary)) return true;
    return String(summary || '').split(/[。！？!?\n]/u).some(sentence => {
        if (/(?:并非|不是|不能说|不能认为|不应认为|否认)[^，,；;]{0,30}(?:限于|仅在|未经)/u.test(sentence)) return false;
        if (/(?:未经证实|效果未知)[^。]{0,30}(?:说法|表述|观点|判断)[^。]{0,20}(?:不成立|不正确|有误|错误)/u.test(sentence)) return false;
        const measuredScope = /(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)在[^。！？!?；;\n]{1,140}(?:测试集|评测集|实录数据)[^。！？!?；;\n]{0,40}?(?:内|上|下|中)(?:得到)?(?:验证|成立)/u.exec(sentence);
        if (measuredScope && !/(?:并非|不是|不能|不应|否认|尚未|未经|没有|未曾|未被|假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|讨论|声称|据说)/u.test(sentence.slice(0, measuredScope.index + measuredScope[0].length))
            && !/(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)/u.test(sentence.slice(measuredScope.index + measuredScope[0].length, measuredScope.index + measuredScope[0].length + 50))) return true;
        return /(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)?在[^。]{1,100}(?:条件|语料|数据集|设置|说话人)[^。]{0,30}(?:下验证|中验证|得到验证|成立)/u.test(sentence)
            || /(?:该提升|这些结果|上述结论)(?:只|仅)?限于[^。]{1,100}(?:评测|语料|数据集|问答|场景|条件|设置|样本|任务)/u.test(sentence)
            || /(?:跨语言|跨说话人|新说话人|新硬件|词表外|开放式生成)[^。]{0,80}(?:效果未经证实|效果未知|尚未得到验证)/u.test(sentence);
    });
}


function hasGeneratedInputModelHeadChain(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
    const denied = /(?:并非|并未|没有|不能|尚未|未曾|假设|如果|可能|计划|未来|讨论|提及|独立方法|无关|相关工作)|(?:不|未)(?:曾|实际|直接|真正|再|会|能)*(?:送给|送入|生成|形成|作为|输出|预测)/u;
    for (let index = 0; index + 1 < sentences.length; index++) {
        const first = sentences[index], second = sentences[index + 1];
        if (first.length > 320 || second.length > 320 || denied.test(first) || denied.test(second)) continue;
        if (!/(?:生成|构造|形成)[^。]{1,100}(?:流|序列|样本|查询)[^。]{0,120}(?:特征|表示)[^。]{0,50}作为模型输入/u.test(first)) continue;
        const handoff = /^(?:该|此)输入(?:送给|送入)([^，,。]{1,100})[，,]\s*(?:模型输出|其输出)(?:再|随后)?(?:送给|送入|送)[^，,。]{1,60}分类器(?:预测|输出|判别)[^，,。]{1,50}/u.exec(second);
        if (handoff && /(?:模型|网络|记忆|注意力)/u.test(handoff[1])) return true;
    }
    return false;
}

function hasExplicitEditedVectorHandoff(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:并非|并未|不是|不会|不能|尚未|未曾|不再|假设|假想|假定|设想|如果|若|是否|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|无关)|(?:不|未|没有)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|编辑|变换|移动|映射|使用|接收|承接|送入|作为|合成|重合成|重建)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)/u;
    for (let i = 0; i + 2 < sentences.length; i++) {
        const parts = sentences.slice(i, i + 3);
        if (parts.some(s => s.length > 320 || denied.test(s))) continue;
        const produced = /编码器[^，,。；]{0,80}(?:输出|生成|得到)(?:身份|说话人|潜在|特征)?向量\s*([A-Z][A-Z0-9_]{0,7})(?![A-Za-z0-9_′’\x27])/u.exec(parts[0]);
        if (!produced) continue;
        const variable = produced[1];
        const edit = new RegExp("(?:编辑|变换|适配|投影)(?:阶段|模块|器)?以(?:上一步的|该|此)?" + variable + "为输入[^。；]{0,160}(?:移动|平移|变换|映射|编辑)[^。；]{0,60}(?:得到|输出|生成)" + variable + "[′’\\x27](?![A-Za-z0-9_′’\\x27])", 'u');
        const consumer = new RegExp("^(?:解码器|声码器)(?:以|将|把)(?:上一步的)?(?:(?:离散)?(?:语义|内容)?(?:单元|表示|特征|编码)(?:和|与))?" + variable + "[′’\\x27](?![A-Za-z0-9_′’\\x27])" + "(?:共同)?(?:为条件输入|作为条件输入|作为输入)[^。；]{0,100}(?:合成|重合成|重建|输出)波形", 'u');
        const unused = new RegExp("(?:丢弃|弃用|忽略|不使用|未使用|没有使用)(?:了)?(?:该|此)?(?:向量)?" + variable + "(?:[′’\\x27](?![A-Za-z0-9_′’\\x27]))?", 'u');
        if (!parts.some(s => unused.test(s)) && edit.test(parts[1]) && consumer.test(parts[2])) return true;
    }
    return false;
}

// These closed handoffs identify a produced artifact and its actual consumer.
// Adjacent module names, future plans and unowned intermediate states do not suffice.
function hasTypedNaturalProductHandoff(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|形成|读取|接收|送入|作为|检索|插入|转写|打分)|(?:丢弃|弃用|忽略)(?:了)?(?:该|此|这些|两种)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)/u;
    for (let index = 0; index < sentences.length; index++) {
        const first = sentences[index], second = sentences[index + 1] || '';
        const revokedOrForeign = /(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)|(?:基线|对照|其他|另一个|另一种)(?:的)?(?:自回归)?解码器/u;
        if (first.length > 320 || denied.test(first) || revokedOrForeign.test(first)) continue;
        // A decision head retrieves a concrete exemplar and inserts that exemplar.
        if (/调用头判断[^。；]{1,100}[，,]触发后检索[^，,。；]{1,30}范例并作为引导插入生成序列/u.test(first)) return true;
        if (!second || second.length > 320 || denied.test(second) || revokedOrForeign.test(second)) continue;
        const memories = [...first.matchAll(/([\u4e00-\u9fff]{1,8}记忆)(?:保留|表示|编码)/gu)].map(match => match[1]);
        if (/交叉注意力[^。；]{0,120}输出/u.test(first) && new Set(memories).size === 2
            && /解码器[^。；]{0,60}(?:交替)?读取(?:这)?两种记忆[^。；]{0,80}(?:预测|输出|生成)[^，,。；]{1,30}/u.test(second)) return true;
        if (/编码器[^。；]{0,120}输出[^，,。；]{0,30}(?:表示|特征)序列/u.test(first)
            && /^(?:该|此)(?:表示|特征)序列作为(?:因果)?(?:Conformer|Transformer|循环网络|时序模型)的?输入[^。；]{0,120}末态映射为[^，,。；]{1,30}/u.test(second)) return true;
        // Independence of shared test audio is not a denial of its explicit ASR use.
        if (/语音合成[^。；]{0,100}生成音频[^。；]{0,100}(?:同一|该|此)音频直接作为[^，,。；]{0,30}(?:自动语音识别|ASR)的输入被转写为文本/u.test(first)
            && /^转写文本与原始文字分别送入同一[^，,。；]{0,20}(?:大语言模型|LLM)作答[，,]两种回答再交由同一[^，,。；]{0,20}验证器打分得到/u.test(second)) return true;
    }
    return false;
}

// Closed signal/representation handoffs. These are actual processing paths,
// not a count of action words or a paper/model-name exception.
function hasTypedProcessingProductChain(summary) {
    const denied = /(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|先前工作|他人|独立方法|无关|另一|其他(?:模型|方法|系统|病人|数据|信号|样本)|并非|并未|不是|没有|不能|不会|尚未|未曾|不再|否认|否定|反驳|驳斥|引用|引述|转述)|(?:不|未|没)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:统计|计算|形成|生成|输出|送入|进入|作为|使用|采用|处理|池化|注入|承接|给出|锁定|确定|执行|发生|应用|实现|实施|进行|完成)|(?:丢弃|弃用|忽略)|(?:说法|表述|观点|判断|过程|流程)[^。；]{0,20}(?:错误|有误|不成立|不正确|未执行)/u;
    const normalizeNotice = value => String(value || '').replace(/^(?:不过|然而|但是|可是|但|实际上)[，,]?\s*/u, '');
    const revoked = /^(?:上述|以上|前述|该|此|这一|这些|所述)(?:方法|流程|链|步骤|过程|说法|表述|处理|交接|轮廓|表示|隐表示|候选集合|解释集合)[^。；]{0,35}(?:不成立|不正确|错误|有误|没有|被弃用|被丢弃|不代表|不属于|(?:未|不)(?:被|曾|实际|真正|根本|直接|再|继续)*(?:使用|采用|输入|消费|送入|注入|应用|发生|执行|实施|实现))/u;
    const forwardRevoked = /^(?:(?:下述|如下|以下|后述)(?:方法|流程|链|步骤|过程)[^。；]{0,50}(?:不成立|没有|并未|未执行|未发生|只是设计|只是示意|仅为示意|尚待实现|有待实现)|(?:对照|基线|先前|相关|其他|另一)(?:系统|模型|方法|工作|研究)[^。；]{0,40}(?:方法|流程|步骤)[^。；]{0,15}(?:如下|所示))/u;
    const safe = (parts, objectKind = '') => {
        if (!parts.every(part => part && part.length <= 320)) return false;
        let text = parts.join('。');
        if (objectKind === 'candidates') text = text.replace(/(?:意图(?:与|和)槽位|意图|槽位|标签)假设(?=[，,]|$)/u, '候选对象');
        if (objectKind === 'pooled') text = text.replace(/与录音数无关的(?:病人级|患者级)隐表示/u, '固定尺寸隐表示');
        return !denied.test(text) && !/(?:^|[，,])\s*(?:但|然而|不过|可是|却)/u.test(text);
    };
    for (const paragraph of String(summary || '').split(/\n\s*\n/u)) {
        if (/[！？!?]/u.test(paragraph)) continue;
        const parts = paragraph.split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean);
        for (let index = 0; index < parts.length; index++) {
            if (forwardRevoked.test(normalizeNotice(parts[index - 1]))) continue;
            const first = parts[index], second = parts[index + 1] || '', third = parts[index + 2] || '';
            const clauses = first.split(/[，,]/u).map(clause => clause.trim());
            if (safe([first]) && !revoked.test(normalizeNotice(second))) {
                if (/^梯度归因(?:统计|计算)各频点对[^，,。；]{1,24}(?:影响|贡献)(?:权重)?(?:并)?(?:形成|生成|得到)(?:加权|频率权重)轮廓$/u.test(clauses[0])
                    && /^(?:该|此)(?:加权|频率权重)?轮廓(?:作为|被用作)加权函数(?:进入|用于)(?:经典与神经|经典|神经)?(?:广义互相关|GCC|互相关)(?:流水线(?:对比|比较)?|计算|处理)$/u.test(clauses[1] || '')) return true;
                if (/^(?:前端|编码前端)(?:将|把)[^，,。；]{1,160}(?:拼接|融合)(?:并|后|再)(?:经|通过)(?:二维|2D)卷积(?:编码|处理)?$/u.test(clauses[0])
                    && /^(?:输出|得到|生成)融合(表示|特征)(?:并(?:将|把)(?:该|此)\1)?(?:送入|交给)(?:基于[A-Za-z][A-Za-z0-9-]{0,30}的)?(?:时频(?:网格)?主干|分离网络|分离主干)(?:处理|编码|变换)(?:为|得到|生成)(?:待调制的)?分离(?:表示|特征)$/u.test(clauses[1] || '')) return true;
                const epoch = /^脑电(?:分析|处理)对目标(?:音|刺激)锁定取(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:计算|生成)(?:事件相关谱扰动|ERSP)$/u.exec(clauses[0]);
                const baseline = /^以(?:语境前|刺激前|目标前)(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:作为)?基线(?:作|进行)(?:时频变换|时频分析)$/u.exec(clauses[1] || '');
                const clusters = /^(?:经|通过)([1-9][0-9]*)次置换检验(?:确定|识别|得到)显著(?:性)?簇(?=$|并(?:比较|分析|检验))/u.exec(clauses[2] || '');
                if (epoch && baseline && clusters) {
                    const [start, end, baselineStart, baselineEnd, iterations] = [...epoch.slice(1), ...baseline.slice(1), clusters[1]].map(Number);
                    if ([start, end, baselineStart, baselineEnd, iterations].every(Number.isFinite)
                        && start < end && start <= baselineStart && baselineStart < baselineEnd && baselineEnd <= end) return true;
                }
            }
            if (safe([first, second], 'pooled') && !revoked.test(normalizeNotice(third))
                && /^(?:同一病人的|同一患者的)(?:多录音|多部位录音)(?:编码|声学)特征(?:经)?展平后(?:送入|交给)(?:感知)?重采样器$/u.test(clauses[0])
                && /^由固定数量(?:的)?可学习查询(?:经)?交叉注意力(?:池化|汇聚|压缩)(?:为|得到)(?:与录音数无关的)?(?:病人级|患者级)隐表示$/u.test(clauses[1] || '')
                && (first.match(/隐表示/gu) || []).length === 1
                && (/^(?:冻结的)?(?:大)?语言模型[^，,。；]{0,60}[，,]\s*(?:以|通过|使用)(?:可训练)?门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入(?:其)?各层/u.test(second)
                    || /^门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入冻结的(?:大)?语言模型(?:的)?各层/u.test(second))) return true;
            if (safe([first, second, third], 'candidates') && !revoked.test(normalizeNotice(parts[index + 3]))
                && /^(?:候选列举|候选枚举|枚举阶段)(?:从|依据|根据)[^，,。；]{1,90}(?:挑出|列出|筛出)[^，,。；]{1,70}(?:候选|假设)$/u.test(clauses[0])
                && /^(?:输出|生成|形成)(?:包含正确标签(?:在内)?的)?候选集合$/u.test(clauses[1] || '')
                && /^(?:否决推理|排除推理|辨析阶段)以(?:上述|该|此)候选集合为输入[，,]/u.test(second)
                && /为每个(?:错误|竞争)候选(?:生成|写出)[^，,。；]{1,70}(?:理由|解释)[，,]\s*(?:形成|输出|得到)解释集合$/u.test(second)
                && /^(?:最终标签|标签阶段|标签预测)(?:承接|依据|使用)(?:前述辨析|上述解释集合|该解释集合)(?:给出|输出|预测)(?:结构化)?(?:意图(?:与|和)槽位(?:-槽值)?|语义标签|最终标签|标签|意图|槽位|语义框)(?:结果)?$/u.test(third)) return true;
        }
    }
    return false;
}

function hasExplicitNaturalProductChain(summary) {
    if (hasTypedProcessingProductChain(summary)) return true;
    if (hasCachedCausalStateHandoff(summary)) return true;
    if (hasTypedNaturalProductHandoff(summary)) return true;
    if (hasExplicitEditedVectorHandoff(summary)) return true;
    if (hasGeneratedInputModelHeadChain(summary)) return true;
    if (hasExplicitArtifactHandoff(summary)) return true;
    if (hasConcreteProductHandoff(summary)) return true;
    if (hasPosteriorUpdateProductChain(summary)) return true;
    if (hasBlockLayoutProductChain(summary)) return true;
    // 只接受已说明的产物被下一处理模块实际使用，不以动作数量或序号充数。
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const denied = /(?:并非|并未|不是|没有|不能|不会|尚未|未曾|不再|是否|讨论|提及|另一(?:个)?专家|假设|设想|假定|如果|若|可能|预计|预期|计划|未来|建议|应当|应该)|(?:不|未)(?:被|能|曾|直接|实际|真正|也|只|还|再|会)*\s*(?:预测|计算|给出|输出|生成|得到|形成|池化|标准化|送入|拼接|融合)/u;
    for (let i = 0; i < sentences.length; i++) {
        const first = sentences[i];
        if (first.length <= 320 && !denied.test(first)
            && /编码器[^，,。；]{0,45}帧(?:级)?表示经均值和标准差池化形成定长向量[，,]\s*该向量标准化后送入[^，,。；]{0,30}逻辑回归输出类别/u.test(first)) return true;
        const second = sentences[i + 1];
        if (!second || first.length > 320 || second.length > 320 || denied.test(first) || denied.test(second)) continue;
        const produced = /([\u4e00-\u9fff]{1,8}专家)(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){0,200}?(?:预测|计算|给出|输出|生成|得到)(?:对应的|单曲的|歌曲的|一个)?质量分/u.exec(first);
        const consumed = /^([\u4e00-\u9fff]{1,8}专家)(?:把|将)该质量分与(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){1,180}?(?:拼接|融合)/u.exec(second);
        if (produced && consumed
            && !produced[1].endsWith(consumed[1]) && !consumed[1].endsWith(produced[1])) return true;
    }
    return false;
}

function hasConcreteUnnumberedMethodChain(summary) {
    // 只接受同一机制句中的明确处理模块和数据衔接，不用泛化动作词计数代替方法说明。
    const moduleKinds = [
        ['encoder', /编码器|提取器/giu],
        ['decoder', /解码器|声码器/giu],
        ['sensor', /麦克风|传感器/giu],
        ['circuit', /电路/giu],
        ['network', /网络|变换器|Transformer/giu],
        ['generator', /(?:流|生成|预测|分类|回归)头|生成器/giu]
    ];
    const objects = [
        ['envelope', /幅度包络|缓慢包络|包络/gu, /(?:幅度)?包络/gu],
        ['feature', /声学特征|音频特征|视觉特征|帧对齐特征/gu, /(?:声学|音频|视觉|这些)?特征/gu],
        ['latent', /潜变量|潜表示/gu, /潜变量|潜表示/gu],
        ['waveform', /波形|音频块|语音块/gu, /波形|音频块|语音块/gu],
        ['pressure', /共振压力|声压/gu, /共振压力|声压/gu],
        ['label', /词级标签|音素标签|类别标签|数字标签/gu, /(?:词级|音素|类别|数字|这些)?标签/gu]
    ];
    const operation = /(?:维护|保持|提取|拾取|编码|解码|合成|生成|预测|输出|判决|做整句平均判决)/u;
    const excluded = /(?:并非|并未|没有|不能|不会|尚未|未曾|不再|不负责|不用于|假设|设想|假定|如果|若|可能|计划|未来|拟采用|建议|应当|应该|对比|比较|相比|优于|胜过|另一(?:种|套)|独立方法)|(?:不|未)(?:被|能|曾|直接|实际|真正|也|只|还|再|会)*\s*(?:维护|保持|提取|拾取|编码|解码|合成|生成|预测|输出|判决|送入|传递|映射|注入|缩放)/u;
    for (const raw of String(summary || '').split(/[。！？!?；;\n]/u)) {
        // 括注内的英文逗号不能把模块名与它的中文动作拆开。
        const sentence = raw.replace(/（[^）]*）|\([^)]*\)/gu, '');
        if (excluded.test(sentence)) continue;
        // 半径条件先被编码为明确表示，再由该表示控制相邻时频块的输入。
        // 只有产物和实际交接同时出现才接受；提及模块或动作列表不能充数。
        const radiusProduct = sentence.match(/半径编码器[^，,。；]{0,32}映射(?:为|成|到)频率相关表示/u);
        if (radiusProduct) {
            const following = sentence.slice(radiusProduct.index + radiusProduct[0].length);
            if (/(?:该|此|频率相关)表示经(?:特征调制|FiLM)[^，,。；]{0,100}(?:注入[^，,。；]{0,40}块间传递|上一块输出[^，,。；]{0,40}下一块输入)/u.test(following)) return true;
        }
        const clauses = sentence.split(/[，,]/u);
        const stages = [];
        for (let index = 0; index < clauses.length; index++) {
            const clause = clauses[index];
            for (const [kind, pattern] of moduleKinds) {
                pattern.lastIndex = 0;
                const actor = pattern.exec(clause);
                if (!actor) continue;
                const actionText = clause.slice(actor.index + actor[0].length);
                if (!operation.test(actionText)) continue;
                const data = objects.filter(([, pattern]) => {
                    pattern.lastIndex = 0;
                    return pattern.test(actionText);
                });
                const state = /(?:维护|保持)[^，,]{0,16}(?:有界|固定容量|会话|历史)[^，,]{0,8}(?:记忆|状态|缓存)/u.test(actionText);
                const decision = /做整句平均判决/u.test(actionText);
                if (!data.length && !state && !decision) continue;
                stages.push({ kind, actor: actor[0], index, clause, data, state, decision });
            }
        }
        for (const first of stages) for (const second of stages) {
            if (first.index >= second.index || first.kind === second.kind) continue;
            // 明确重提上游数据，并送入后续模块；判决网络本身也必须有实际处理动作。
            for (const [, , alias] of first.data) {
                alias.lastIndex = 0;
                if (!alias.test(second.clause)) continue;
                const transfer = second.clause.match(/(?:送入|传递给|传递到|馈入|接入|交给)/u);
                if (transfer && second.clause.indexOf(second.actor) > transfer.index) return true;
            }
            // 有界历史状态与块内生成属于同一分块机制，而不是两个独立模型的性能对比。
            if (first.state && /(?:保持|维持)[^，,]{0,16}(?:语义|声学|上下文)[^，,]{0,8}连续/u.test(first.clause)
                && second.kind === 'generator' && second.data.some(([kind]) => kind === 'latent' || kind === 'waveform')
                && /块内/u.test(second.clause) && /(?:切块|分块|按块)/u.test(sentence)) return true;
        }
    }
    return false;
}

// 只认相邻两句内的具体产物交接，不以动作数量或跨段落共现替代处理链。
function hasAdjacentConcreteMethodChain(summary) {
    const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
    const excluded = /(?:并非|并未|没有|不能|不会|尚未|不再|不负责|(?:未|不)(?:以|把|将|使用)|未曾|未被|未曾被|提及输出|讨论输出|(?:未|不)(?:曾|实际|直接)?(?:输出|提取|生成|接收|选择|建立|更新|存入|处理|映射|注入|缩放)|假设|设想|假定|如果|若|可能|预计|预期|计划|准备(?:输出|生成|接收)|未来(?:将|会)|拟采用|建议|应当|应该|对比(?:方法|模型|网络|滤波器)|比较(?:方法|模型|网络|滤波器)|相比|优于|另一(?:种|套)|独立方法)/u;
    const roles = [
        ['filter', /滤波器/u], ['network', /网络|变换器/u], ['tracker', /跟踪器/u],
        ['expert', /[\u4e00-\u9fff]{1,8}专家/u],
        ['encoder', /半径编码器/u], ['conditioning', /特征调制|FiLM/u],
        ['pool', /候选(?:说话人|程序)?池/u], ['predictor', /预测器/u],
        ['interface', /搜索接口/u], ['backbone', /主干/u], ['selection', /散度目标|来源收集/u],
        ['vocabulary', /词表/u], ['retention', /置信保留/u], ['editing', /人工编辑/u],
        ['checking', /二次检查/u], ['refinement', /精炼器/u]
    ];
    const products = [
        /误差信号/gu, /(?:频率相关表示|该表示)/gu, /质量分/gu, /嵌入/gu, /质心/gu, /候选(?:说话人)?池/gu,
        /候选(?:只读搜索)?请求/gu, /草稿/gu, /提示句池/gu,
        /可朗读句(?:子)?/gu, /父程序/gu, /子程序/gu, /语料(?:文本)?/gu
    ];
    const actor = sentence => roles.map(([kind, pattern]) => ({ kind, match: pattern.exec(sentence) }))
        .filter(item => item.match).sort((a,b) => a.match.index - b.match.index)
        .map(item => item.kind === 'expert' ? `expert:${item.match[0]}` : item.kind)[0];
    const canonical = token => token.replace('该表示', '频率相关表示').replace('候选说话人池', '候选池')
        .replace('候选只读搜索请求', '候选请求').replace('可朗读句子', '可朗读句').replace('语料文本', '语料');
    for (let i = 0; i + 1 < sentences.length; i++) {
        const first = sentences[i], second = sentences[i+1];
        if (first.length > 320 || second.length > 320 || excluded.test(first) || excluded.test(second) || /^未来/u.test(first) || /^未来/u.test(second)) continue;
        const firstActor = actor(first), secondActor = actor(second);
        if (!firstActor || !secondActor || firstActor === secondActor) continue;
        if (!/(?:提取|更新|建立|生成|输出|得到|选择|选出|送入|合并|存入|映射)/u.test(first)
            || !/(?:接收|输入|送入|进入|切分|聚集|提取|改写|处理|播放|截取|更新|建立|扩展|拼接|融合|注入|缩放)/u.test(second)) continue;
        for (const pattern of products) {
            pattern.lastIndex = 0;
            for (const match of first.matchAll(pattern)) {
                const token = canonical(match[0]);
                if (token === '频率相关表示') {
                    if (firstActor === 'encoder' && secondActor === 'conditioning'
                        && /半径编码器[^，,。；]{0,32}映射(?:为|成|到)频率相关表示/u.test(first)
                        && /(?:该|此|频率相关)表示经(?:特征调制|FiLM)[^，,。；]{0,100}(?:注入[^，,。；]{0,40}块间传递|上一块输出[^，,。；]{0,40}下一块输入)/u.test(second)) return true;
                    continue;
                }

                const firstClauses = first.split(/[，,]/u);
                let startOffset = 0;
                const clauseIndex = firstClauses.findIndex(clause => {
                    const contains = match.index >= startOffset && match.index < startOffset + clause.length;
                    startOffset += clause.length + 1;
                    return contains;
                });
                const productionClause = firstClauses[clauseIndex];
                if (!productionClause) continue;
                if (token === '质量分' && !/(?:输出|得到|生成|计算|预测|给出)(?:对应的|单曲的|歌曲的|一个)?质量分/u.test(productionClause)) continue;
                const localIndex = productionClause.indexOf(match[0]);
                const before = productionClause.slice(0, localIndex);
                if (!/(?:提取|更新|建立|生成|输出|得到|选择|选出|送入|合并|存入)[^。；]{0,60}$/u.test(before)) continue;
                // 省略主语只能承接同句此前的处理角色，不能借另一个角色的产物。
                const localActor = actor(before);
                const priorActors = firstClauses.slice(Math.max(0, clauseIndex - 3), clauseIndex)
                    .map(actor).filter(Boolean);
                if (localActor ? localActor !== firstActor
                    : priorActors.at(-1) !== firstActor) continue;
                pattern.lastIndex = 0;
                const consumption = [...second.matchAll(pattern)].find(next => canonical(next[0]) === token);
                if (!consumption) continue;
                const normalizedSecond = second.replace(/候选说话人池|候选只读搜索请求|可朗读句子|语料文本/gu, canonical);
                const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const consumes = new RegExp(`(?:接收)(?:这些|该)?${escaped}`
                    + `|以[^。；]{0,70}${escaped}[^。；]{0,30}为输入`
                    + `|${escaped}[^。；]{0,70}(?:进入|送入|用于[^。；]{0,30}(?:扩展|检查))`
                    + (token === '质量分' && firstActor.startsWith('expert:') && secondActor.startsWith('expert:')
                        ? `|以(?:上一步|该|这些)?${escaped}为(?:基础|输入|依据)` : ''), 'u');
                const containerConsumes = token === '候选池'
                    && /^候选池把[^。；]{0,50}(?:嵌入|来源)[^。；]{0,30}(?:存放|聚集)/u.test(normalizedSecond.split(/[，,]/u)[0]);
                const ownedConsumption = normalizedSecond.split(/[，,]/u).some(clause =>
                    actor(clause) === secondActor && consumes.test(clause));
                if (ownedConsumption && token === '质量分' && secondActor.startsWith('expert:')) {
                    const clauses = normalizedSecond.split(/[，,]/u);
                    const hasOwnedFusion = clauses.some((clause, index) =>
                        /(?:拼接|融合|校准)/u.test(clause)
                        && (actor(clause) || clauses.slice(Math.max(0, index - 3), index).map(actor).filter(Boolean).at(-1)) === secondActor);
                    if (!hasOwnedFusion) continue;
                }
                if (ownedConsumption || containerConsumes) return true;
            }
        }
    }
    return false;
}

function hasConcreteCompressionPurpose(summary) {
    return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence =>
        !/(?:假设|如果|可能|未来|计划|没有|并非|不能|尚未|不需|无需)/u.test(sentence)
        && /(?:需|需要|旨在|目标是)把(?:原始)?(?:音频)?波形压缩为[^，,。]{0,30}(?:离散\s*(?:token|码元)|离散表示|编码)/iu.test(sentence)
        && /(?:可传输|可重建|码率|存储|通信)/u.test(sentence));
}

function coreSummarySentenceView(text, sourceText) {
    // 方法名内的感叹号不是句末；只保护原文确有同名且后接中文属格的写法。
    return String(text || '').replace(/(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9_-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,39}){0,3})!(?=的)/gu, (match, name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![A-Za-z0-9_])${escaped}!(?![A-Za-z0-9_])`, 'u').test(String(sourceText || ''))
            ? match.slice(0, -1) + '\uE000' : match;
    });
}

// 前向次数和实测时间本身就是运行负担，不要求作者再加“成本”二字。
function hasConcreteRuntimeDisclosure(summary) {
    return String(summary || '').split(/[。！？!?\n]/u).some(sentence => {
        if (/(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:错误|有误|不成立|不正确|不属实)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u.test(sentence)) return false;
        if (/(?:(?:未|不)(?:曾|实际|直接)?(?:需|需要|进行|执行)|讨论|假说|预计|预期|可能|假设|如果|未来|计划|建议|不需|无需|不能|不会|不进行|不执行|不耗|尚未|没有|未曾|并非|未测|未披露|未报告|未记录|未提供|未给出|未公布|未说明|未统计|不报告|不记录|不披露|不提供|尚无|不代表)/u.test(sentence)) return false;
        const measuredDuration = /(?:训练|推理|部署|(?:监督)?微调|强化学习)(?:平均|每轮|每个epoch)?(?:时间|耗时|用时)?(?:约|大约|为|是|分别为)?\s*(?:[0-9]+(?:\.[0-9]+)?)\s*(?:小时|分钟|毫秒|秒|hours?|minutes?|seconds?|ms|h|s)(?![A-Za-z0-9]|\s*的?\s*(?:(?:训练|测试|验证|评测)(?:用|集)?\s*)?(?:音频|语音|录音|数据|样本|语料|材料))/iu.exec(sentence);
        if (measuredDuration && !/(?:假定|假想|设想)/u.test(sentence)
            && !/(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)/u.test(sentence.slice(measuredDuration.index + measuredDuration[0].length, measuredDuration.index + measuredDuration[0].length + 50))) return true;
        return /(?:推理(?:为|采用|使用)|以)(?:一|单)次语音前向/u.test(sentence)
            || /训练可训练参数(?:量)?为\s*[0-9]+(?:\.[0-9]+)?\s*[kKmMbB](?![A-Za-z0-9])/u.test(sentence)
            || /(?:训练|推理|部署)[^。！？!?；;]{0,40}(?:需要|需|进行|执行)(?:[1-9][0-9]*|[一二两三四五六七八九十]+)次(?:完整(?:的)?|(?:经过|通过)(?:共享)?(?:[A-Za-z0-9_-]+\s*)?(?:编码器|主干|网络|模型)(?:的)?(?:提示条件)?|提示条件(?:的)?)?前向(?:传播|计算)?/u.test(sentence)
            || /(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间(?:约|为|是|分别为)?\s*[0-9]+:[0-5][0-9](?![0-9:])/u.test(sentence)
            || /(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间[（(](?:毫秒|秒|分钟)(?:\/文件)?[）)](?:约|为|是|分别为)?\s*[0-9]+(?:\.[0-9]+)?(?![0-9.])/u.test(sentence);
    });
}

function validateCoreSummarySemanticContract(analysis, options = {}) {
    const sourceText = typeof options === 'string' ? options : String(options.sourceText || '');
    const summary = coreSummarySentenceView(extractSection(String(analysis || ''), '核心摘要'), sourceText);
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
    // 明确写了材料用于哪项具体处理，就不必再强塞“任务”或“输入输出”这些词。
    const purposePattern = /(?:用于|用来|用以)(?:从[^。！？!?.;；,，\n]{1,24}中)?(?:筛查|诊断|检测|识别|转写|翻译|分离|定位|合成|预测|估计)(?![的了地得吧呢而但并或不未没非])(?:[“‘"\'「『])?[A-Za-z0-9\u4e00-\u9fff]{2,48}/;
    // 只在同一分句里判断用途，明确否定的说法和只有一个字的对象不能充数。
    const concretePurpose = summary.split(/[。！？!?.;；,，\n]|而(?:不是|是)|但(?=不能替代)/).some(clause => (
        purposePattern.test(clause)
        && !/(?:并非|并未|不是|不再|不会|不能|不曾|未曾|并不|没有|未被|不成立|不正确|不存在|不属于|不适用)/.test(clause)
        && !/(?:不|未)(?:被|直接|主要|实际|真正|仅|只|也|还|曾|能|会|再|尚)*\s*(?:用于|用来|用以)/.test(clause)
    ));
    if (!/(?:问题|难点|任务|目标|输入|输出|旨在|针对|解决)/.test(summary) && !concretePurpose && !hasConcreteCompressionPurpose(summary)) {
        issues.push('缺少任务问题、输入输出或实际难点');
    }
    const chain = summary.match(/(?:第一|第二|第三|第四|首先|其次|然后|随后|接着|最后|先|再|阶段|步骤|模块|组件|分(?:\d+|[一二三四五六七八九十]+)步)/g) || [];
    const roles = summary.match(/(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|计算|平滑|展平|丢弃)/g) || [];
    const tierRoleStages = new Set([...summary.matchAll(
        /(?<![A-Za-z0-9_])Tier[-‐‑‒–—]([LMH])(?![A-Za-z0-9_])[^；。！？!?\n]{0,120}(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|打分|匹配|投票|检索|推理|判决|路由)/gi
    )].map(match => match[1].toUpperCase()));
    const hasNumberedMethodChain = (chain.length >= 2
        || /分(?:\d+|[一二三四五六七八九十]+)步/.test(summary)) && roles.length >= 2;
    const hasTieredMethodChain = tierRoleStages.size >= 2;
    if (!hasNumberedMethodChain && !hasTieredMethodChain && !hasConcreteUnnumberedMethodChain(summary) && !hasAdjacentConcreteMethodChain(summary) && !hasExplicitNaturalProductChain(summary) && !hasSymbolicGeometryMethodChain(summary)) {
        issues.push('缺少 2–4 步方法链的分工与衔接');
    }
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
    const scopedSymbolicDemonstration = sourceHasQuantitativeEvidence === false
        && /point[- ](?:set|pattern)/i.test(sourceText)
        && /transformation class/i.test(sourceText)
        && /inter[- ]pattern transformation graph/i.test(sourceText)
        && hasScopedSymbolicDemonstration(summary);
    const corpusCurationResult = sourceCorpusCurationResult(sourceText);
    const softwareFunctionalResult = sourceSoftwareFunctionalValidationResult(sourceText);
    const softwareOnlyResult = softwareFunctionalResult
        && classifyGenericSourceQuantitativeEvidence(sourceText, quantitativeSourceSentences) !== true;
    const completeSoftwareResult = hasCompleteSoftwareFunctionalValidationResult(summary, softwareFunctionalResult);
    const completeQuantitativeResult = softwareOnlyResult ? completeSoftwareResult
        : quantitativeResultState.complete || hasCompleteCorpusCurationResult(summary, corpusCurationResult)
            || completeSoftwareResult;
    if (softwareOnlyResult && quantitativeResultState.complete) {
        issues.push('纯软件功能验证来源不支持泛型基准性能结果；须保留同来源的完整性与重复性验证，不能编造准确率或模型性能对比');
    }
    if (softwareFunctionalResult && summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push('原文已有可核的软件完整性与重复性验证结果，不能笼统声明没有关键定量结果；它不等于模型性能、移植性或感知质量');
    }
    if (corpusCurationResult && summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push('原文已有可核的语料清洗质量结果，不能笼统声明没有关键定量结果；它们不等于模型性能实验');
    }
    if (sourceHasQuantitativeEvidence === true && !completeQuantitativeResult) {
        if (softwareOnlyResult) {
            issues.push('已有软件功能验证证据，但摘要没有按同一来源完整匹配运行环境、全新进程、计划与输出哈希、参数与信号组合、负向用例及包测试的关键定量结果');
        } else {
            issues.push('已有证据包含关键定量结果，但摘要没有写清比较对象、评测设置、指标、数值与方向'
            + `（最接近的同句量化候选缺少：${quantitativeResultState.missing.join('、')}）`
            + (quantitativeResultState.candidateIssues.length
                ? `；含数值的句子还须逐句核对：${quantitativeResultState.candidateIssues.map(candidate =>
                    `第${candidate.sentenceNumber}句缺少${candidate.missing.join('、')}`).join('；')}。这些句子不一定都是结果，不得为运行参数编造指标或结论`
                : ''));
        }
    } else if (sourceHasQuantitativeEvidence === false
        && !scopedSymbolicDemonstration && !summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`原文无可核定量结果时必须明确写“${CORE_SUMMARY_RESULT_UNAVAILABLE}”`);
    } else if (sourceHasQuantitativeEvidence === null && !completeQuantitativeResult
        && !summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`缺少完整关键定量结果或明确的“${CORE_SUMMARY_RESULT_UNAVAILABLE}”声明`);
    }
    const explicitBoundary = /(?:边界|局限|适用|失败|尚未|未覆盖|未验证|外推|仅限|受限)/.test(summary);
    const separatedUnverifiedBoundary = /(?:尚未|未曾|未能|未|没有)[^。！？!?\n]{0,60}(?:验证|覆盖|评估|测试)/.test(summary);
    const conditionalFailure = /(?:但|不过|然而)[^。！？!?\n]{0,80}(?:在|对)[^。！？!?\n]{1,60}(?:时|下|中|上)[^。！？!?\n]{0,60}(?:可能|易|会|明显)?(?:失真|退化|恶化|不稳定|不可靠|失效|下降|受损|偏差)/.test(summary);
    const conditionalMetricFailure = summary.split(/[，,；;。！？!?\n]/u).some(clause =>
        /^(?:若|如果|当)[^。！？!?\n]{1,100}(?:一致性|准确率|召回率|识别率|辨识率|性能|结果)[^。！？!?\n]{0,30}(?:回落|下降|退化|恶化|失效|受损)/u.test(clause.trim())
        && !/(?:不会|不再|不能|不曾|没有|不意味着|并非|不是|无法|不|未|无须)[^。！？!?\n]{0,20}(?:回落|下降|退化|恶化|失效|受损)/u.test(clause));
    const scopedConclusionBoundary = /(?:结论|研究结果|研究发现)[^。！？!?\n]{0,40}(?<!不)(?<!非)限于[^。！？!?\n]{1,80}(?:语音|语料|数据|场景|条件|设置|样本|任务)/.test(summary);
    const attentionScopeBoundary = summary.split(/[。！？!?\n]/u).some(sentence =>
        !/(?:并非|不是|不能认为|不可认为|不应认为|没有)|(?:并不|不|未|没有|不会|不能)(?:曾|实际|一直|始终|确实|能|会)*保持不变/u.test(sentence)
        && /(?:结论|研究结果|研究发现)(?<!不)(?<!非)限于(?:视频|音频|图像)(?:自|交叉|跨模态)注意力(?:的)?(?:稀疏化|计算|处理)/u.test(sentence)
        && /(?:音频|视频|图像)(?:自|交叉|跨模态)注意力[^。！？!?\n]{0,30}保持不变/u.test(sentence));
    const observationalCausalBoundary = /(?:观察性|非实验|非干预)[^。！？!?\n]{0,40}(?:不建立|不能建立|不支持|不能证明)[^。！？!?\n]{0,20}因果/.test(summary);
    const uncoveredScopeBoundary = summary.split(/[。！？!?\n]/).some(sentence => (
        /未涵盖[^。！？!?\n]{1,60}(?:语音|语料|数据|场景|条件|设置|样本|任务|攻击|环境|设备|人群|语种|语言|录音)/.test(sentence)
        && !/(?:并非|不是|不存在|没有|并不|不能说|不能认为|无法断言)[^，,；;。！？!?\n]{0,20}未涵盖/.test(sentence)
        && !/未涵盖[^。！？!?\n]{0,90}(?:说法|表述|观点|判断|结论)[^。！？!?\n]{0,20}(?:不成立|不正确|不属实|并非事实|不符合事实|错误|有误)/.test(sentence)
        && !/未涵盖[^。！？!?\n]{0,60}(?:并非事实|不是事实|并不属实|不属实|不是真的)/.test(sentence)
    ));
    if (!explicitBoundary && !separatedUnverifiedBoundary && !conditionalFailure
        && !conditionalMetricFailure && !scopedConclusionBoundary && !attentionScopeBoundary && !observationalCausalBoundary && !uncoveredScopeBoundary && !hasNaturalScopedBoundary(summary)) {
        issues.push('缺少结论适用边界、失败条件或未验证范围');
    }
    const scopedResourceDisclosure = summary.split(/[。！？!?\n]/).some(sentence => (
        /(?:训练|推理|部署)/.test(sentence)
        && /\d/.test(sentence)
        && /(?:计算量|计算复杂度|MACs?|FLOPs?|GPU|CPU|TPU|NPU|RTX|显卡|(?:训练|推理|采样|优化|迭代)步数|\d\s*(?:[kKmMgG]\s*)?\s*(?:步|轮|次))/i.test(sentence)
    ));
    const cost = hasConcreteRuntimeDisclosure(summary) || summary.includes(CORE_SUMMARY_COST_UNAVAILABLE)
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
        const catalogChange = require('./lib/tag-catalog-change.js');
        const appendOnlyCatalog = !Object.hasOwn(stage, 'registryUpgradeFrom')
            ? catalogChange.resolveAppendOnlyProofCatalog(stage.registrySha256,
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
        } else if (stage.projectionContract === tagRulesApi.TAG_PROMPT_TEXT_CONTRACT) {
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
    if (context) {
        // 使用原有完整 fresh 身份核验；另一个论文或来源上下文不能借来解释方法名。
        fresh.assertFreshPaper(paper);
        source = fresh.readFreshSource(context.runDir, paper, context);
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
    if (manifest?.contracts?.coreSummary !== CORE_SUMMARY_CONTRACT_VERSION
        || stage.contractVersion !== CORE_SUMMARY_CONTRACT_VERSION) return '核心摘要阶段记录未采用当前 v3 规则。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.fingerprint || ''))) return '核心摘要阶段的输入指纹缺失，或格式无效。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.outputAnalysisSha256 || ''))) return '核心摘要阶段的输出正文哈希缺失，或格式无效。';
    if (options.skipSemantic !== true) {
        let semanticOptions = options;
        const hasExplicitSource = typeof options === 'string' || Object.hasOwn(options, 'sourceText');
        if (!hasExplicitSource && (hasScopedSymbolicDemonstration(summary)
            || /(?:采样计划|render[- ]plan)\s*(?:哈希|hash)/iu.test(summary)
                && /(?:输出\s*哈希|output[- ]byte\s+hash)/iu.test(summary)
            || /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9_-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,39}){0,3}!(?=的)/u.test(summary))) {
            try { semanticOptions = { ...options, sourceText: coreSummaryBoundMethodSource(paper) }; }
            catch (error) { return `核心摘要方法名的原封存来源未通过核验：${error.message}`; }
        }
        const semanticIssue = validateCoreSummarySemanticContract(paper?.analysis, semanticOptions);
        if (semanticIssue) return semanticIssue;
    }
    if (stage.summarySha256 !== summarySha256) return '核心摘要正文的哈希与阶段记录不一致。';
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
        contractVersion: stage.contractVersion,
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
        const tableOptions = {
            contractVersion: options.experimentTableContractVersion
                || EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
            documentType: parsed?.documentType,
            sourceText: options.sourceText
        };
        let tableIssue = validateExperimentTableContract(analysis, tableOptions);
        // 仅损失名称列的方向歧义需要重放封存证据，普通正文不额外读取来源。
        if (options.paper && tableIssue
            && /^实验结果第 \d+ 张表指标“(?:损失|loss)”缺少 ↑\/↓ 方向$/i.test(tableIssue)) {
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
    sourceSoftwareFunctionalValidationResult,
    hasCompleteSoftwareFunctionalValidationResult,
    coreSummarySentenceView,
    validateCoreSummarySemanticContract,
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

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
