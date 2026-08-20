const crypto = require('crypto');

const REQUIRED_ANALYSIS_SECTIONS = Object.freeze([
    '评分',
    '机器摘要',
    '标签',
    '作者与机构',
    '毒舌点评',
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
const EXPERIMENT_TABLE_CONTRACT_VERSION = 'bounded-v1';
const METHOD_DETAIL_CONTRACT_VERSION = 'detailed-v1';
// Manual/offline analyses must contain actual full-text evidence in addition
// to the structural contract used by API analyses.  This is deliberately a
// separate opt-in contract so old, valid API records remain backward
// compatible while new manual records cannot silently collapse to an abstract
// plus generic process commentary.
const MANUAL_DEPTH_CONTRACT_VERSION = 'full-text-evidence-v1';
const ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION = 'high-confidence-v1';
const MANUAL_COMPLETE_STATUS = 'manual_complete';
const MANUAL_COMPLETE_PROVENANCE_VERSION = 2;
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
    /全文事实[：:]|专项复核|二次复核输入\/输出边界|manual[-_ ](?:complete|full-text)|论文明确写到/i
]);
const REQUIRED_RECOVERY_STAGES = Object.freeze([
    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
]);
const RECOVERY_STAGE_TERMINAL_STATUSES = Object.freeze({
    imageDiscovery: Object.freeze(['complete', 'no_candidates', MANUAL_COMPLETE_STATUS]),
    imageDownload: Object.freeze(['complete', 'skipped', 'no_candidates', 'no_downloadable_images', MANUAL_COMPLETE_STATUS]),
    primaryAnalysis: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    openSourceScan: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    demoLinkScan: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    revision: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    tableRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    methodRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    structureRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    scoringAudit: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    imageSupplement: Object.freeze(['complete', 'skipped', 'no_candidates', 'no_high_value_images', 'no_downloadable_images', MANUAL_COMPLETE_STATUS])
});
const EXPERIMENT_TABLE_LIMITS = Object.freeze({
    maxTables: 2,
    maxDataRows: 12,
    maxMetricColumns: 8
});
const TABLE_IDENTIFIER_HEADER_RE = /(?:^|\b)(?:method|model|system|config(?:uration)?|dataset|corpus|benchmark|task|language|scenario|condition|setting|split|category|type|modality|version)(?:\b|$)|方法|模型|系统|配置|数据集|语料|基准|任务|语言|场景|条件|设置|划分|类别|类型|模态|版本/i;

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
    const analysis = String(text || '');
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => {
        const heading = new RegExp(`(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*\\n`, 'm');
        return !heading.test(analysis);
    });
}

function countSectionHeadings(text, title) {
    const heading = new RegExp(`(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*(?=\\n|$)`, 'gm');
    return [...String(text || '').matchAll(heading)].length;
}

function getDuplicateRequiredSections(text) {
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => countSectionHeadings(text, title) > 1);
}

function extractSection(text, title) {
    const heading = new RegExp(
        `(^|\\n)##(?!#)\\s*${escapeRegExp(title)}[：:\\s]*\\n([\\s\\S]*?)(?=\\n##(?!#)\\s|$)`,
        ''
    );
    return heading.exec(String(text || ''))?.[2]?.trim() || '';
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
        const invalidColumnCounts = [];
        const separatorColumns = splitMarkdownTableRow(lines[index + 1]).length;
        while (end < lines.length) {
            const line = lines[end];
            const cells = splitMarkdownTableRow(line);
            if (!line.trim()) break;
            if (cells.length < 2 && !/^\s*\|.*\|\s*$/.test(line)) break;
            dataRows += 1;
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
            return !normalized || TABLE_IDENTIFIER_HEADER_RE.test(normalized);
        }).length;
        tables.push({
            header,
            dataRows,
            separatorColumns,
            invalidColumnCounts,
            metricColumns: Math.max(0, header.length - identifierColumns)
        });
        index = Math.max(end, index + 2);
    }
    return tables;
}

function validateExperimentTableContract(analysis) {
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
    return null;
}

function analysisManifestRequiresExperimentTableContract(manifest) {
    return manifest?.contracts?.experimentTables === EXPERIMENT_TABLE_CONTRACT_VERSION;
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
    // The old manual gate only checked that the method section was long.  A
    // template could therefore pass with a short abstract, three generic
    // innovation bullets and one two-column placeholder table.  The API path
    // has an explicit full-paper review/repair chain; manual_complete must
    // meet the same reader-visible quality floor even when no LLM is called.
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
    if (/(?:从复现角度|本分析|人工(?:审计|接管)|manual_complete|不能由本分析|不补造|实验数字只采用|按来源逐项核对|论文明确写到|第\s*(?:\d+|[一二三四五六七八九十]+)\s*个证据块|证据块|结果证据\s*\d+|方法事实\s*\d+|实验事实\s*\d+|实现细节\s*\d+|实验\/部署细节\s*\d+)/i.test(analysis)) {
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
    return null;
}

function analysisManifestRequiresMethodDetailContract(manifest) {
    return manifest?.contracts?.methodDetail === METHOD_DETAIL_CONTRACT_VERSION;
}

function isRecoveryStageTerminal(stage, status) {
    return Boolean(RECOVERY_STAGE_TERMINAL_STATUSES[stage]?.includes(status));
}

function manualStableValue(value) {
    if (Array.isArray(value)) return value.map(manualStableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, manualStableValue(value[key])]));
}

function manualSha256(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(manualStableValue(value)))
        .digest('hex');
}

// Text evidence is hashed as its exact UTF-8 bytes (without JSON string
// quoting) so Node and the Python publishing gate bind to the same value.
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
        if (!REQUIRED_ANALYSIS_SECTIONS.includes(item.section)
            || ['评分', '标签', '作者与机构'].includes(item.section)) {
            return `manual evidenceLedger ${item.id} section 必须对应事实正文章节`;
        }
        sections.add(item.section);
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

function validateManualV2Takeover(manifest, takeover, sourceSha256 = '', options = {}) {
    if (takeover.version !== MANUAL_COMPLETE_PROVENANCE_VERSION
        || takeover.mode !== MANUAL_COMPLETE_STATUS) {
        return 'manualTakeover.version/mode 必须为 manual_complete v2';
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

    const stages = manifest?.stages || {};
    const evidence = takeover.stageEvidence;
    if (!evidence || typeof evidence !== 'object') return 'manualTakeover.stageEvidence 缺失';
    for (const stage of MANUAL_STAGE_EVIDENCE_STAGES) {
        const item = evidence[stage];
        const state = stages[stage];
        if (!item || typeof item !== 'object' || !state || item.status !== state.status) {
            return `manualTakeover.stageEvidence.${stage} 与阶段状态不一致`;
        }
        if (!Number.isInteger(item.attempts) || item.attempts < 2) {
            return `manualTakeover.stageEvidence.${stage}.attempts 至少为 2`;
        }
        for (const key of ['inputSha256', 'outputSha256', 'auditSha256']) {
            if (!/^[a-f0-9]{64}$/.test(String(item[key] || ''))) {
                return `manualTakeover.stageEvidence.${stage}.${key} 必须是 SHA-256`;
            }
        }
        if (!Array.isArray(item.reviewedClaims) || item.reviewedClaims.length === 0) {
            return `manualTakeover.stageEvidence.${stage}.reviewedClaims 不能为空`;
        }
        const hint = MANUAL_STAGE_CLAIM_HINTS[stage];
        if (hint && !item.reviewedClaims.some(claim => hint.test(String(claim)))) {
            return `manualTakeover.stageEvidence.${stage}.reviewedClaims 缺少该阶段专属事实范围`;
        }
    }
    return null;
}

function validateManualTakeoverManifest(manifest, sourceSha256 = '', options = {}) {
    const manualStatuses = Object.values(manifest?.stages || {})
        .some(stage => stage?.status === MANUAL_COMPLETE_STATUS);
    if (!manualStatuses && manifest?.manualTakeover === undefined) return null;
    const takeover = manifest?.manualTakeover;
    if (!takeover || typeof takeover !== 'object' || Array.isArray(takeover)) {
        return 'manual_complete 阶段缺少 manualTakeover provenance';
    }
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
    const headings = [...String(analysis || '').matchAll(/^##(?!#)\s*([^\n]+?)\s*$/gm)]
        .map(match => match[1].replace(/[：:]\s*$/, '').trim());
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

function validateTagSectionContract(analysis, parsed) {
    const block = extractSection(analysis, '标签');
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length !== 4) return '标签章节必须恰好四行';
    if (!/^(?:#[^\s,，;；、]+)(?:\s+#[^\s,，;；、]+){2,4}$/.test(lines[0])) {
        return '标签首行必须包含 3-5 个以空格分隔的 #标签';
    }
    if (!/^主任务标签\s*[:：]\s*#\S+$/.test(lines[1])) return '标签章节缺少合法主任务标签行';
    if (!/^主方法标签\s*[:：]\s*#\S+$/.test(lines[2])) return '标签章节缺少合法主方法标签行';
    if (!/^补充标签\s*[:：]\s*#\S+(?:\s+#\S+)*$/.test(lines[3])) return '标签章节缺少合法补充标签行';
    if (!Array.isArray(parsed?.tags) || parsed.tags.length < 3 || parsed.tags.length > 5) return '标签首行包含非白名单标签';
    if (!parsed.primaryTaskTag) return '标签章节缺少可解析的主任务标签';
    if (!parsed.primaryMethodTag) return '标签章节缺少可解析的主方法标签';
    const allTags = lines[0].match(/#[^\s]+/g) || [];
    const taskTag = lines[1].match(/#[^\s]+/)?.[0];
    const methodTag = lines[2].match(/#[^\s]+/)?.[0];
    const supplemental = lines[3].match(/#[^\s]+/g) || [];
    if (!allTags.includes(taskTag) || !allTags.includes(methodTag)) return '主任务/主方法标签必须出现在标签首行';
    const expectedSupplemental = allTags.filter(tag => tag !== taskTag && tag !== methodTag);
    if (new Set(supplemental).size !== supplemental.length ||
        supplemental.length !== expectedSupplemental.length ||
        supplemental.some(tag => !expectedSupplemental.includes(tag))) {
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
    const tagIssue = validateTagSectionContract(analysis, parsed);
    if (tagIssue) return `分析结果标签契约无效: ${tagIssue}`;
    if (options.enforceExperimentTableContract === true) {
        const tableIssue = validateExperimentTableContract(analysis);
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
    hasRequiredSections,
    validateMachineSummaryContract,
    validateTagSectionContract,
    validateTopLevelSectionContract,
    findAnalysisEditorialLeakages,
    validateAnalysisEditorialLeakageContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION,
    ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION,
    REQUIRED_RECOVERY_STAGES,
    RECOVERY_STAGE_TERMINAL_STATUSES,
    MANUAL_COMPLETE_STATUS,
    MANUAL_COMPLETE_PROVENANCE_VERSION,
    MANUAL_AUDIT_CHECKS,
    EXPERIMENT_TABLE_LIMITS,
    splitMarkdownTableRow,
    extractMarkdownTables,
    validateExperimentTableContract,
    analysisManifestRequiresExperimentTableContract,
    validateMethodDetailContract,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION,
    analysisManifestRequiresMethodDetailContract,
    isRecoveryStageTerminal,
    manualSha256,
    manualTextSha256,
    findManualBoilerplate,
    validateManualEvidenceLedger,
    validateManualTakeoverManifest,
    getInvalidAnalysisReason
};

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
