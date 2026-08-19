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
const ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION = 'high-confidence-v1';
const MANUAL_COMPLETE_STATUS = 'manual_complete';
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

function analysisManifestRequiresMethodDetailContract(manifest) {
    return manifest?.contracts?.methodDetail === METHOD_DETAIL_CONTRACT_VERSION;
}

function isRecoveryStageTerminal(stage, status) {
    return Boolean(RECOVERY_STAGE_TERMINAL_STATUSES[stage]?.includes(status));
}

function validateManualTakeoverManifest(manifest, sourceSha256 = '') {
    const manualStatuses = Object.values(manifest?.stages || {})
        .some(stage => stage?.status === MANUAL_COMPLETE_STATUS);
    if (!manualStatuses && manifest?.manualTakeover === undefined) return null;
    const takeover = manifest?.manualTakeover;
    if (!takeover || typeof takeover !== 'object' || Array.isArray(takeover)) {
        return 'manual_complete 阶段缺少 manualTakeover provenance';
    }
    if (takeover.version !== 1 || takeover.mode !== MANUAL_COMPLETE_STATUS) {
        return 'manualTakeover.version/mode 非法';
    }
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
    EXPERIMENT_TABLE_LIMITS,
    splitMarkdownTableRow,
    extractMarkdownTables,
    validateExperimentTableContract,
    analysisManifestRequiresExperimentTableContract,
    validateMethodDetailContract,
    analysisManifestRequiresMethodDetailContract,
    isRecoveryStageTerminal,
    validateManualTakeoverManifest,
    getInvalidAnalysisReason
};

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
