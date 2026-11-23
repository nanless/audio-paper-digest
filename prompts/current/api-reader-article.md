# API 论文解读写作要求

## 用途

事实修复和评分完成后，本阶段为博客生成完整的论文解读。机器摘要、标签、分数和评分理由仍保存在已有分析记录里，不在这里改写。

## 提示词内容

~~~
请为刚进入语音、音乐或音频领域的研究生写一篇清晰、严谨、自洽的中文论文解读。读者读完应能复述论文解决的核心问题、端到端数据流、关键公式直觉以及实验结论成立的具体前提与代价。

【写作规则仅用于执行，不写入正文；只使用本篇原文实际涉及的概念与证据】

## 一、证据边界、术语与中文表达
- **唯一事实来源**：首次写作只依据文末 `<paper_input>` 中的论文原文与本次实际收到的官方原图像素；若提供了上一版草稿（非“无”），以它为底稿优先局部修复反馈项并保持未出错部分的标题与数字稳定，提交完整 JSON。
- **中文术语与音频标准写法**：用自然平实的中文讲清对象、处理过程与统计口径，后文称呼保持前后统一（与核心摘要/原文一致，避免同一指标忽称精确率忽称准确率）。通用概念一律用自然中文（如具身、对齐、流程、基线、权衡），**国际通用缩写、音频指标与硬件/信号单位保持原标准写法**（如 ViSQOL、STOI、PESQ、UTMOS、DNSMOS、SI-SDR、LSD、MCD、FAD、WER、CER、EER、MOS、CLAP、F1、RTF、GPU、CPU、FFT、MDCT、LoRA、bps、kHz、ms 等，首次出现时括号解释含义，不生硬直译成“虚拟语音质量客观听众”或“图形处理器”）；`logit` 译为“对数几率”（非“对数值”），`nuisance parameter` 译为“干扰参数”或“无关参数”，`critic` 按任务称“价值评估模型”或“辅助分数模型”，`score` 适用于原文定义为对数密度对输入的梯度时。
- **数字与排版规范**：实测指标、样本规模和超参数用阿拉伯数字并保留原文千分位、精度与 `%`（44,000、19.44、100% 不改写或四舍五入）；中文与英文或阿拉伯数字之间留一个半角空格（如“185 个样本”“35B-A3B”“84.0%”），遇到混合专家总参/激活参简写（如 35B-A3B）按原文定义准确展开；数学与统计专名及自然中文序数、逐指词、构词短语保留纯正汉字（最小二乘、一阶/二阶、二维频谱、一对一、置信区间半宽、第一个/第二步、两阶段/三阶段、两段式、每一帧/每一维、哪一帧/两者/任何一级）。
- **克制自然的语调**：严禁使用“记住这个顺序”“务必记住”“不要忘记”等说教口吻；不写系统评分、标签、校验状态、提示词流程话术或套话（如“这张图确实可见”“从像素可见”“该式的三层含义”“可分三层理解”“比较问题是：”“这张表支撑的判断是”“本次核验返回 200”“资源清单未标明”）。教学例子明确标出，不添无来源数值。

## 二、四模块叙事骨架与分节规范
- **节数与 `kind` 取舍**：按本次代码要求组织 **5–9 节（推荐 5–7 节）**，可选 `kind` 集合为：`background / related_work / problem / method_overview / component / training / experiment_setup / result / ablation / limitation / reproduction / synthesis`。必须覆盖 `problem`、`method_overview`、`result`，以及 `limitation` 或 `synthesis` 至少其一：
  1. **问题模块（1 节 `problem`）**：直接融合必要前置直觉、精确输入输出定义与已有主流路线的具体物理/统计瓶颈，不再拆出重复动机的独立 `background` / `related_work`（除非跨学科理论论文确需前置数学基础）。
  2. **方法模块（`method_overview` + 1–2 节 `component` / `training`）**：围绕“五环架构与完整流水线清单”讲透方法（未披露项如实说明，绝不编造）：
     - ① **输入输出信号与张量规格**：采样率、帧长/步长、码率、通道/特征维度与任务目标；
     - ② **端到端分步数据流**：用一个贯穿全文的具体输入样本，按顺序（1 → 2 → 3 …）追踪它在各模块/分支间的张量形状、帧率传递以及拆分/汇合点；
     - ③ **关键公式与机制直觉**：使用 `[[FORMULA_<ordinal>]]` 锚定核心公式；
     - ④ **训练目标与参数冻结边界**：冻结与更新模块、训练阶段、损失函数与梯度流（无训练论文直接说明未训练哪些模型及实际检索/规则/闭式求解/推理步骤，不单开空壳 `training` 节）；
     - ⑤ **推理与部署执行路径**：自回归或分块流式方式、前瞻窗口/缓存状态、采样步数及原文披露的延迟/RTF/显存开销。
  3. **实验模块（`result` + 可选 `ablation`）**：将评测协议与公平性核查融入 `result` 开头（不单开干瘪 `experiment_setup`），紧贴主表剖析结果；有消融或负结果诊断时开 1 节 `ablation`。
  4. **收束模块（1 节 `limitation` 或 `synthesis`）**：将方法假设边界、未验证部署条件、复现核对前提（区分代码开源、权重可下载、系统可运行三件事）及工程选型建议（何时值得尝试、复现第一步、需补哪项验证）融为一节，不在前序各段尾机械追加免责句。
- **标题与段落节奏**：每个 `sections[i].heading` 直接承载本篇具体机制、模块名、核心矛盾或实验结论，不写裸泛词，严禁在全文中连续 3 节及以上套用“问题本质：/方法全景：/核心机制：”等模板化前缀，不在任何标题或 `####` 小标题中放“图 1 / Figure 1 / 表 1 / Table 1”。单段保持 **120–320 汉字（硬上限 420 字）**，段间用合法 `\n\n` 空行分隔；任一小节散文正文超过 950 个汉字时必须用 2–3 个简洁 `####` 四级小标题或结构化条目列表（至少 2 项）拆分层次。同一结果数值集中于一个主小节说明，跨节不反复念数字。

## 三、公式、原图与表格的严格绑定协议

### 公式（`formulaBindings`）
- 仅从 `READER_ARTIFACTS` 的 `FORMULA_ORDINALS_AVAILABLE` 中挑选至多 5 条完整原始 TeX 公式（清单为 `[]` 时输出 `"formulaBindings": []` 且正文不出现占位符）。
- 正文用独占一段的 `[[FORMULA_<ordinal>]]` 表示（仅出现一次，且 `targetKind` 与所在小节 `kind` 一致），行内数学统一用规范 `\(...\)`，不手写展示公式。
- 先交代公式计算目标与关键符号（标量/向量、下标、求和范围、单位），并在紧随其后的自然段中有机讲透三个实质问题：采用该数学形式的物理/统计直觉、关键项及极端取值下的行为变化、以及输出如何驱动下一步变换或梯度更新（不顺着符号念绕口令，不套用“三层含义”模板）。

### 官方原图（`figurePlacements`）
- 仅挑选请求末尾“模型本次真正收到像素”且有教学价值的原图（最多 4 张；存在可装配原图时至少选 1 张，每个 `figureOrdinal` 至多出现一次）。
- **语义就位**：架构/流程图放入 `method_overview` / `component` / `training`；定量曲线/柱状/消融图放入 `result` / `ablation`。`marker` 写成独占一段的 `[[FIGURE_<figureOrdinal>]]`，`targetKind` 等于所在小节 `kind`。
- 每项提供 12–120 字自然中文图注 `chineseCaption`（不含“图 N / Figure N”前缀）；`focusPoints` 可输出 `[]` 或 2–4 个针对这张图的简短观察要点（每项 6–120 字）。占位符前一段写自然读图导引，后一段结合实际可见坐标轴、图例、曲线、实心/斜纹填充（使用“全部/所有/唯一”前逐组核对无例外）展开实质解释；正文/图注与像素冲突时如实指出。

### 实验表格与防极值幻觉（`tableBindings`）
- **四步深度实验剖析**：① 交代数据集/划分/指标方向并核查训练规模、参数量、码率、因果流式 vs 离线等公平性前提；② 提炼跨行趋势、最强收益与最尖锐代价权衡，标明 oracle/事后最优；③ 定量交代消融归因与缺失消融缺口；④ 核查标准差/置信区间/人工听测规模与失效案例，至少点出一个未胜出项、负结果或未评测范围。
- **表文极值与方向硬核验**：在表前或表后声称某方法/数值为“最优/最佳/最高/最低/排名第一/SOTA”之前，必须逐格核对同表同组同列全部其他可比方法行及指标方向（`↑` 越高越好，`↓` 越低越好），绝不把同列已有更优值的条目称作最优，也绝不把高 WER/高延迟写成最优；百分点和相对百分比严格区分，不跨量纲相减或自算原文未报告差值。
- **优先使用可用原表并禁止重复**：有定量主结果时，`result` 必须包含含主要基线的主结果表（优先用 `completeTable` 或 `selection` 呈现合格原表；仅当主结果原表 `eligible: false` 时用连续逐字 `source_quotes` 整理，严禁拿消融表冒充主结果表）。同一原表（相同 `sourceTableOrdinal`）不得重复展示相同完整表或数据格重合 >= 50% 的重叠子集。每张表前后各有独立自然段，不逐行复述数字；多值单元格（如 `a | b`）就近交代各分量指标与量纲。
- **四种互斥表格结构**（`tableBindings` 按最终正文表序从 1 开始，每表只选一种，不混用字段）：
  1. `completeTable`：正文独占一段 `[[TABLE_<tableIndex>]]`，记录恰好为 `{"tableIndex":1,"completeTable":{"sourceTableOrdinal":2}}`（程序编译完整原表并生成来源绑定）。
  2. `selection`：正文独占一段 `[[TABLE_<tableIndex>]]`，记录恰好为 `{"tableIndex":1,"selection":{"sourceTableOrdinal":1,"sourceRows":[0,1,2],"sourceColumns":[0,1,2,3]}}`（仅 `eligible:true`；`sourceRows[0]` 必须来自 `TABLE_<ordinal>_HEADER_ROWS` 且含具体指标列名、非空列分组分隔行；先逐表核对 `TABLE_J_INDEX_RULES` 和 `TABLE_J_SHAPE`：rows=16 表示合法行索引0..15，不是0..16，columns 同理，索引互不重复且各至少 2 项）。
  3. `artifact_table`（兼容模式）：正文手写完整 Markdown 表，记录含 `tableIndex,sourceType:"artifact_table",sourceTableOrdinal,cellBindings,sourceQuotes:[]`，`cellBindings` 逐格记录 `renderedRow,renderedColumn,sourceRow,sourceColumn`（`renderedRow=0` 为表头、`1` 为第一数据行，分隔行不计数；`sourceRow/sourceColumn` 为原矩阵 0 起始坐标）。
  4. `source_quotes`：正文手写完整 Markdown 表，记录含 `tableIndex,sourceType:"source_quotes",sourceTableOrdinal:null,cellBindings:[],sourceQuotes:["..."]`（仅覆盖真实实验条件/方法/指标/数值与单位的连续逐字原句，不拼凑参考文献编号或年份占位表；列头若带单位符号如 `%`/`s`/`GiB`，对应来源行须有逐字单位证据，否则优先绑定原表或把量纲写在表前说明中）。
- **独立 PDF 引文（仅限明确授权恢复）**：只有本次实际提供独立官方封存 PDF 原字符全文且明确授权时，`source_quotes` 才可增加 `pdfSourceQuotes` 字符串数组（12–4000 字符、最多 64 条，逐字来自该 PDF，仅合并空白，且 `sourceQuotes` 与 `pdfSourceQuotes` 至少一项非空）；首次普通写作绝不输出 `pdfSourceQuotes` 或 `sealedPdfQuoteEvidence`。

### 顶层复现规格卡与概念桥（`implementationSpecs` / `conceptBridges`）
- `implementationSpecs` 精确包含 6 个单行纯文本字符串字段（每项 4–500 字，无换行/Markdown/HTML/内部核验话术）：`trainingData`、`computeHardware`、`keyHyperparams`、`inferenceCost`、`openSourceArtifacts`、`appendixHighlights`。无训练阶段的论文直接写明“无模型训练阶段（纯冻结推理/提示驱动）”及实际推理配置，真正缺失项写“原文未披露”；`openSourceArtifacts` 须与论文真实代码/权重/数据/演示公开状态严格一致。
- `conceptBridges` 默认输出 `[]`（允许 0–4 组），优先把术语分工自然融入正文；仅确需辨析时声明 1–2 组，含 `terms`（2–4 个不同术语）、`sectionKind`（与占位符所在小节 `kind` 一致）、`marker`（独占一段的 `[[CONCEPT_BRIDGE_1]]`）与 `explanation`（45–320 字，须包含全部声明 `terms` 并说明分工与组合作用）。

## 四、输出 JSON 结构（只输出单个合法 JSON 对象，无 Markdown 围栏或解释）

{
  "contract": "reader-draft",
  "schemaFingerprint": "c885be94603c4da688140a9b370c93a71ce5674acb2b0ded5011d3a4053ac5c4",
  "readerTitle": "语音与文本如何共同支持音频检索",
  "oneSentenceThesis": "用一句话写清问题、方法选择、最强证据和主要代价",
  "conceptBridges": [],
  "figurePlacements": [
    {
      "figureOrdinal": 1,
      "targetKind": "method_overview",
      "marker": "[[FIGURE_1]]",
      "chineseCaption": "双分支音频检索架构示意：左侧语义编码器与右侧声学编码器在跨模态投影层汇合",
      "focusPoints": [
        "先沿输入到输出的箭头看主路径",
        "再比较语义分支与声学分支在哪里汇合"
      ]
    }
  ],
  "tableBindings": [
    {
      "tableIndex": 1,
      "selection": {
        "sourceTableOrdinal": 1,
        "sourceRows": [0, 1, 2],
        "sourceColumns": [0, 1, 2, 3, 4]
      }
    },
    {
      "tableIndex": 2,
      "sourceType": "source_quotes",
      "sourceTableOrdinal": null,
      "cellBindings": [],
      "sourceQuotes": ["全文中逐字连续、覆盖表内关键数字与单位的原句"]
    }
  ],
  "formulaBindings": [
    {
      "formulaOrdinal": 1,
      "targetKind": "component",
      "marker": "[[FORMULA_1]]"
    }
  ],
  "implementationSpecs": {
    "trainingData": "训练与评测数据集名称、规模/时长、语种与划分（原文未提及写“原文未披露”）",
    "computeHardware": "GPU/TPU 型号与数量、训练步数/轮数与耗时（无训练阶段写明无模型训练阶段及实际推理硬件）",
    "keyHyperparams": "优化器、学习率、批大小、核心层数/维度/码本、温度/门限或损失权重",
    "inferenceCost": "推理实时率 RTF、延迟、吞吐、显存或参数量（原文未提及写“原文未披露”）",
    "openSourceArtifacts": "用自然中文如实说明代码/权重/数据/演示的公开状态及 README 覆盖情况",
    "appendixHighlights": "附录或补充材料中的关键证明、补充消融、许可限制或典型失效案例（无附录写“原文未披露”）"
  },
  "sections": [
    {
      "kind": "problem",
      "heading": "流式音频检索在短窗口下为何难以兼顾语义与声学对齐",
      "body": "完整、连续、面向初学者的段落"
    }
  ]
}

<paper_input>
论文标题：{title}
arXiv ID：{arxivId}

本次代码检查的数量和长度要求：

{mechanicalContract}

带 ID 的论文原文证据：

{sourceEvidence}

代码校验反馈：

{validationFeedback}

上一版完整 JSON 草稿（首次生成时为“无”）：

{previousDraft}
</paper_input>
~~~
