'use strict';
// Pure encoding selection. No marker or header grants a request, source scope,
// patch target, fee allowance or normal completion.
const codec = require('./protocol-codec');
const { isDeepStrictEqual: equal } = require('node:util');
const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const original = require('./reader-legacy-records.json').ordinal;
const WIRE = original.wireFamily, RECORD = original.recordFamily, COMPILATION = original.compilationFamily;
const PRIOR_MODERN_WIRE_FP = '334889bc92083a45f374ac667bbb4580aa703ae3a2ef7df1001e2df41e7cb84d';
const wireHeader = () => codec.recordHeader(codec.contract(WIRE), WIRE);
const oldWireHeader = () => codec.historicalHeader(WIRE, 'bounded-existing-nodes', null);
const priorModernWireHeader = () => codec.historicalHeader(WIRE, 'bounded-existing-nodes', PRIOR_MODERN_WIRE_FP);
function isWire(value) { return codec.hasValidHeader(value, WIRE); }
function readWireHeader(value) {
    if (!isWire(value)) throw new Error('Ordinal request format is unknown or mixed');
    return codec.recordHeader(value.contract, WIRE, value.schemaFingerprint);
}
const isCurrentWire = value => codec.isCurrentHeader(value, WIRE);
const isModernWire = value => isWire(value) && Object.hasOwn(readWireHeader(value), 'schemaFingerprint');
function selectedHeader(family, request) {
    readWireHeader(request);
    return isModernWire(request) ? codec.recordHeader(codec.contract(family), family)
        : codec.historicalHeader(family, family === RECORD ? 'bound-request-evidence' : 'source-bound-compilation');
}
function isRecord(value, request) {
    return codec.hasValidHeader(value, RECORD)
        && equal(codec.recordHeader(value.contract, RECORD, value.schemaFingerprint), selectedHeader(RECORD, request));
}
function isCompilation(value, request = null) {
    return codec.hasValidHeader(value, COMPILATION) && (!request
        || equal(codec.recordHeader(value.contract, COMPILATION, value.schemaFingerprint), selectedHeader(COMPILATION, request)));
}
function compilationHeader(request = null) {
    return request ? selectedHeader(COMPILATION, request)
        : codec.recordHeader(codec.contract(COMPILATION), COMPILATION);
}
function standardPatchHeader(request) {
    readWireHeader(request);
    return isModernWire(request) ? codec.recordHeader(codec.contract(original.patchFamily), original.patchFamily)
        : codec.historicalHeader(original.patchFamily, 'bounded-existing-nodes');
}
function buildStaticPrefixV2Template(header) {
    const headerPrefix = JSON.stringify(header).slice(0, -1) + ',';
    const exampleJson = headerPrefix
        + '"requestToken":"<填入文末本次16位requestToken>",'
        + '"replacements":['
        + '{"targetOrdinal":1,"value":"修复后的完整字符串正文或标题"},'
        + '{"targetOrdinal":2,"value":{"tableIndex":1,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],"sourceQuotes":["原文逐字连续结果句"]}}'
        + ']}';
    return [
        '只修当前已存在且明确列出的普通节点，只输出获准修改项。正确事实、数字单位、方法归属、比较条件、原文引文、图表与公式标记及未列入本次目标的其他节点均保持不变。',
        '',
        '### 零、严格输出协议（裸 JSON 与类型保真）',
        '- 整段响应必须严格是一个裸 JSON 对象（以 `{` 开头、以 `}` 结尾），禁止 Markdown 代码围栏（如 ```json）、前后说明、注释或第二个 JSON 对象。',
        '- 顶层只能且必须包含 4 个键：`contract`、`schemaFingerprint`、`requestToken`、`replacements`，严禁重复键或额外字段（不要输出 `path`、`draftSha256`、`oldSha256`、`version`）。',
        `- \`contract\` 固定为 ${JSON.stringify(header.contract)}，\`schemaFingerprint\` 必须 64 位逐字完整写为 ${JSON.stringify(header.schemaFingerprint)}（不能漏字符或改字符）。`,
        '- `requestToken` 必须原样逐字复制文末给出的 16 位小写十六进制本次请求标识。',
        '- `replacements` 为 1 到 8 项的 JSON 数组，只能以 `]` 关闭、整段以 `]}` 结尾；每项仅含 `targetOrdinal` 与 `value` 两个键，不写 `path` 或 `oldSha256`。',
        '- `targetOrdinal` 只能是本轮授权清单中 1 到 N 的字面整数（如 `1`，不能写 `1.0`、`1e0` 或字符串 `"1"`），不重复、不越界、最多 8 个。',
        '- `value` 必须与该目标的 `valueType` 严格同类型：`string` 节点给完整替换字符串（多段用合法 JSON 转义 `\\n\\n` 分隔）；`object` 节点（如 `tableBindings[k]`、`figurePlacements[k]`、`conceptBridges[k]`、`formulaBindings[k]`、`implementationSpecs`）必须直接给 JSON 对象本身 `{...}`，严禁序列化成被引号包裹的字符串；`array` 节点直接给 JSON 数组本身 `[...]`。',
        '- 输出示例（示意字符串节点与对象节点并存；数组节点同理直接给 `[...]`）：',
        exampleJson,
        '- 修改后必须实质消除核验反馈指出的问题，不要逐字回传仍有错误的旧值；未列入本轮授权清单的其他节点由程序保留，不要在本轮输出。',
        '',
        '### 一、中文表达、术语与排版规范',
        '- **自然术语与标准缩写**：用平和朴实的中文说明对象与处理过程，不写宣传语、不生硬直译（`nuisance parameter` 译为“干扰参数/无关参数”而非“讨厌参数”；保留 ViSQOL、STOI、PESQ、WER、CER、MOS、RTF、GPU、CPU、FFT、MDCT 等标准指标与硬件原名并首次括号解释，不把 ViSQOL 译成“虚拟语音质量客观听众”；`logit` 译为“对数几率”而非“对数值”；`critic` 按任务称“价值评估模型”或“辅助分数模型”，不译成“评论家/评论更新/评论与学生”）。',
        '- **禁用中英夹杂与校验口癖**：严禁在中文正文或标题夹杂裸英文普通词（如 alone、over、abstain、noisy、without、embodied、grounding、pending、backchannel、scaling、alignment、rollout、tradeoff、lookahead、pipeline、baseline 等），严禁使用“记住这个顺序”“务必记住”“不要忘记”等说教口吻、模板化校验套话（“这张图确实可见/从像素可见/比较问题是：/这张表支撑的判断是/本表数值与单位依据论文 PDF”）及提示词核验口癖（“该式的三层含义/可分三层理解/三层读法/怎样进入下一步/可写作者/本次核验返回 200/资源清单未标明”）。',
        '- **数字与空格规范**：中英文及阿拉伯数字之间留一个半角空格（如“185 个样本”“35B-A3B”“84.0%”）；数学专名及自然中文序数、逐指词、构词短语保留纯正汉字（最小二乘、一阶/二阶、二维频谱、一对一、置信区间半宽、第一个/第二步、每一帧/每一维、两阶段/三阶段、两段式、哪一帧/两者/任何一级，绝不写成“最小 2 乘/1/2 宽/第 3 个/每 1 帧/2 者之间/哪 1 帧”）。',
        '',
        '### 二、获准目标内的解释、段落与专有字段约束',
        '- **实质补清、杜绝注水**：在获准目标内补清概念对象、模块数据与因果衔接、公式背后的数学动机/极端取值行为/下游作用（行内数学用 `\\(...\\)`，不顺着符号硬念绕口令）及比较条件与指标含义。扩写只能补充原文未展开的机制、条件或实验细节，不换词重复已有规模/步骤，不套用“……为何……”“前一步……后一步……”凑字数；严禁编造论文未给出的数字、维度、梯度、消融、对比或参考文献编号，不硬塞“建议做网格搜索”，沿用本篇已核准术语符号与来源协议。',
        '- **段落、子标题与标题规范**：多段目标保持每段 120–320 汉字（硬上限 420 字），散文超过 950 汉字的小节须使用 `####` 子标题或结构化列表（至少 2 项）建立层次，段间留空行（JSON 字符串用合法 `\\n\\n`），不遇分号或两三句就碎切，不重复句首或段尾免责句；窄目标不得越权扩段。任何标题不得含“图 1/Figure 1/表 1/Table 1”，且不得连续 3 节及以上套用“问题本质：/方法全景：/核心机制：/主实验验证：”等模板化前缀。',
        '- **专有对象节点规范**：`conceptBridges` 术语组合含 2–4 个不同概念（各项 2–48 字符），解释全部分工、搭配原因与新增作用；`figurePlacements` 的 `chineseCaption` 为 12–120 字单行自然中文图注（不含“图 N / Figure N”前缀）并保持图-节语义就位，图文采用紧凑自然衔接（不强插 `> **看图路径：**`）；`implementationSpecs` 保留六个必填单行纯文本来源核实字段（`trainingData`/`computeHardware`/`keyHyperparams`/`inferenceCost`/`openSourceArtifacts`/`appendixHighlights`）及可选 `audioSignalSpecs`（无换行/Markdown/HTML/核验话术，行内公式用 `\\(...\\)`，无训练阶段标明无模型训练阶段，真正缺失再写“原文未披露”）。',
        '',
        '### 三、表格、极值与图表像素核对',
        '- **极值与图表核验**：声称表内“最优/最低/最高/第一/SOTA”前，逐格核对同表同列全部可比行及指标方向（`↑/↓`），绝不颠倒方向或误报非最优；描述图例颜色、柱体实心或斜纹填充及子图轴向时，用“全部/所有/只有/唯一”前须逐组核对无例外，不混淆图例颜色与方法行名。',
        '- **表格来源与防重复**：保留真实方法、条件、指标、单位与数值，按原表真实列数呈现，不为宽表补解释列；同一原表（相同 `sourceTableOrdinal`）不得重复展示相同完整表或数据格重合 >= 50% 的重叠子集，严禁把消融表冒充主结果表放进 `result` 小节；使用 `selection` 时 `sourceRows[0]` 须为含具体指标列名的真实表头行（不选空列分隔行），表前后表述与实际行列数一致，不对精简子表宣称“列出全部 N 项”；表后评述提炼跨行规律、代价权衡与未胜出项而非逐行复述。',
        '- **`source_quotes` 与单位严审**：`source_quotes` 绑定仅含 `tableIndex`/`sourceType`（`"source_quotes"`）/`sourceTableOrdinal`（必须为 `null`）/`cellBindings`（必须为 `[]`）/`sourceQuotes`（逐字连续结果原句），不要照抄 `artifact_table` 的 `sourceTableOrdinal` 或 `cellBindings`；严禁把任意数字、参考文献编号、年份或页码拼成占位表。列头单位（如 `%`、`s`、`GiB`）须在对应来源行有逐字单位证据，原文裸数字时优先绑原表或不在列头硬加括号单位符号；每表紧邻评述只对应本表。修改后仍要通过正常完整 Reader 质量与来源检查。',
        '',
        '整篇机械约束（只作检查参考，不扩大本次目标）：',
        '{{mechanicalContract}}',
        '',
        '来源证据（只作事实与来源核对依据，不可编造证据外内容）：',
        '{{evidence}}',
        '',
        '当前授权目标（只允许修改此处列出的 targetOrdinal，并严格匹配各目标 valueType）：',
        '{{targets}}',
        '',
        '核验反馈（逐项消除下列问题）：',
        '{{feedback}}',
        '',
        '本次请求标识（必须原样填入响应 JSON 的 requestToken 字段）：{{requestToken}}'
    ].join('\n');
}
function template(request = wireHeader()) {
    const header = readWireHeader(request);
    if (sha(original.template) !== original.templateSha256) throw new Error('Original ordinal template bytes differ');
    if (!isModernWire(request)) return original.template;
    if (header.schemaFingerprint === PRIOR_MODERN_WIRE_FP) {
        return original.template.replace(
            original.templateHeaderPrefix,
            JSON.stringify(priorModernWireHeader()).slice(0, -1) + ','
        );
    }
    if (isCurrentWire(request)) return buildStaticPrefixV2Template(header);
    throw new Error('Ordinal template for schemaFingerprint is not registered');
}
function tokenDomain(request) {
    const header = readWireHeader(request);
    return isModernWire(request) ? header : header.contract;
}
function completionWireHeader(completion) {
    if (!isCompilation(completion)) throw new Error('Ordinal completion format differs');
    if (!codec.isCurrentHeader(completion, COMPILATION)) return oldWireHeader();
    if (!isModernWire(completion.ordinalProtocol)
        || !equal(completion.ordinalProtocol, readWireHeader(completion.ordinalProtocol))) {
        throw new Error('Current completion lacks its exact request format');
    }
    return completion.ordinalProtocol;
}
function matchesStage(stage, manifest, completion) {
    const header = completionWireHeader(completion);
    const actual = { contract: stage?.ordinalPatchContract,
        ...(Object.hasOwn(stage || {}, 'ordinalPatchSchemaFingerprint') ? { schemaFingerprint: stage.ordinalPatchSchemaFingerprint } : {}),
        ...(!Object.hasOwn(header, 'schemaFingerprint') ? { version: header.version } : {}) };
    return equal(actual, header) && manifest?.contracts?.readerTargetOrdinalPatch === header.contract;
}
module.exports = { WIRE, RECORD, COMPILATION, PRIOR_MODERN_WIRE_FP, wireHeader, oldWireHeader, priorModernWireHeader,
    readWireHeader, isWire, isCurrentWire, isModernWire,
    recordHeader: request => selectedHeader(RECORD, request), isRecord, isCompilation, compilationHeader,
    standardPatchHeader, template, templateSha: request => sha(template(request)), tokenDomain,
    completionWireHeader, matchesStage };
