# API 读者文章 Prompt — 面向刚入门研究者的论文解读

## 用途

在事实修复和最终评分完成后，生成博客真正展示的连续读者文章。机器摘要、标签、分数和评分理由仍由旧 canonical 结构承载，本阶段不重写这些字段。

## Prompt 内容

~~~
请为刚进入语音/音乐/音频领域的研究生写一篇可核对、能复述方法的中文技术解读。准确性、学习依赖和实验条件优先于修辞；用具体动作和自然段落讲清楚，不写营销式判断。

论文标题：{title}
arXiv ID：{arxivId}

默认从原文独立写作。事实来源只有下方论文原文证据与本次收到的官方原图像素；不继承其他生成分析的解释、评价或推断。若提供修复草稿，它只标示待修正文，事实仍须回到原文核对。

带 ID 的论文原文证据：

{sourceEvidence}

代码校验反馈：

{validationFeedback}

上一版完整 JSON 草稿（首次生成时为“无”）：

{previousDraft}

本次由代码提供的机械契约（数量与门槛以此为准）：

{mechanicalContract}

若上一版不是“无”，必须以它为底稿，优先精确修复校验反馈指出的局部问题，同时复核其他已通过结构，禁止无理由换标题、重排数字或重写全文。最终仍输出完整 JSON，不得只输出差异片段。

写作与事实要求：

1. 开场交代输入、目标、必须保留的信息和输出，随后按学习依赖展开：任务与相关路线 → 方法全景 → 组件与计算 → 训练/构造/推理 → 实验条件 → 结果与反证 → 复现与收束。只讲论文实际研究的任务；教学例子明确标为例子，不添加无源的数值或效果。
2. 术语首次出现先用白话解释，再给英文名或缩写；后文简称固定。组合机制须紧接着说明两个术语各自的分工、搭配理由和新增作用。先沿一个样本走完输入 → 表示 → 组件 → 目标 → 输出，再展开公式；指代能唯一回指，前置概念先于依赖它的结论。
3. 每节承担一个具体教学任务，用问题、操作或机制作标题。遵守机械契约的节数与正文汉字范围，不以写满上限为目标；这里统计汉字，不是 JSON 字符数、英文长度或 token 数。篇幅用于计算过程、比较条件和复现细节，不用重复摘要、泛泛背景、反问或免责声明凑字数。重提结果时增加新对照、机制或适用条件。
4. 用准确动词和自然段落直接讲论文。比喻确有帮助时才使用，随后对应到真实信号/组件，不把比喻当性质证明。不要输出分数、标签、机器摘要、评分理由、prompt、evidence ID、内部校验状态或流程元话语；不得写“本节同时出现两个术语”“表前需要”“承担宽表要求”等作者自述，JSON示例中的说明不是正文模板。
5. 方法说明原文给出的安排理由和已验证对照。仅按证据说明参数冻结/更新、梯度路径、监督来源和重置时机；未报告时指出具体缺项，不从模型名称推定实现。不补写“拿掉后必然怎样”。无训练论文只说明本研究未训练哪些模型，再讲实际调用、搜索、标注、仿真或计算；不能把无训练等同于确定性求解，也不能从冻结参数推定系统输出确定。
6. 公式先解释符号与输入，再解释计算目标和原文明确的实现。区分原始目标、近似、停止梯度与优化步骤；原文未给出的梯度路径不猜。READER_ARTIFACTS有完整原始TeX时，在方法部分选择至多5条关键公式（只有1条就选1条），用独占段落 `[[FORMULA_<ordinal>]]` 与formulaBindings绑定，代码注入原式；不自行写展示公式。
7. 实验按问题组织：测什么、与谁比、条件是否一致、指标方向、关键数字、支持的判断与限制。分别覆盖有证据的数据/协议、主结果、消融或失败条件、训练/部署成本；除核心结果，按证据展开至少两类论文特有细节。原文报告定量主结果时，result/ablation必须有含必要基线和实际可运行策略的数字表，数据/配置表不能替代。比较必须保留原文实际可运行的策略；搜索最优、oracle和事后最优值另行标明，不能代替可部署收益。
8. 数据、划分、采样、指标、聚合、统计方法及硬件预算按原文交代。每个表格数字要同时核对数据集、模型/基线、实验阶段、指标、单位及聚合对象，数值相同不是同一指标的证据；百分点和相对百分比不同。不同指标的差值不能放到模型列下，不能把自动指标当成人评。原文表头、图注或算术互相冲突时明确标注冲突，不自行编造划分或聚合口径来圆成一致。
9. 每表前用相邻独立段落提出比较问题、公平条件和指标方向，表后用相邻独立段落解释主要收益与具体代价/反例，字数按机械契约；不强求固定段落数，不逐行复述。至少就近说明一个未胜出项、负结果或未评测边界。表格数量/宽度按机械契约，但不得为凑宽度制造无源列、混放不同条件或删除不利基线。
10. 区分论文直接报告、有限解释和未验证推测，分别用“报告/显示”“支持”“可能/待验证”表达。缺失证据不是技术错误，相关性不是因果；未测量误判率、延迟或成本时，不承诺这些量得到改善。训练资源、推理开销、输出帧率与实际延迟分别讨论；总体趋势不等于每组/每步都成立。
11. 只选本次实际收到像素且有教学价值的Figure，最多4张、允许为空。每张图在同一小节形成独立导读段 → 独占marker → 独立解释段，focusPoints给2–4个可执行观察动作；字数按机械契约。不自行输出图片Markdown或URL。没有像素时，只能明确归因地引用图注/正文，不能猜坐标、颜色、曲线或模块位置。
12. 读图先按图例确认完整对象、条件和时间范围，区分分布曲线和单样本标记；同色不必然同对象。核对纵轴是原始指标、相对改变量还是改善量，再结合升降方向判断好坏，不能把曲线向下直接写成性能变差，也不能把末步结果推广全程。像素不能精确辨别的数值/步数不要硬写；原文补充说明明确归因。
13. 相关工作按同输入、同目标、同监督和同运行阶段作有源对照，不把类别差异当同条件胜负。结尾回答何时值得尝试、复现先做什么、还需补哪项验证；保留关键超参数和信息条件，区分代码开源、权重下载和系统可运行。用自然段解决论文特有的误解，不再重复摘要或通用FAQ。

表格与绑定输入：

14. tableBindings按最终正文顺序一一对应。仅 `TABLE_<ordinal>_SELECTION` 明示 `eligible:true` 时优先selection；`eligible:false` 的reasonCodes说明空表头、行身份不明、TeX双写等问题，不能反复尝试selection或猜表头。无法安全选择时用source_quotes整理表，说明依据正文整理；无充分逐字quote时报告具体缺项，不造证据、不把绑定失败当成作者没报告。
15. 表内数字和单位保留原文写法、千分位和精度：44,000不改44000，100%不改100，19.44不四舍五入成19。叙述数量用阿拉伯数字，数字与拉丁单位留空格；原文转换出现粘连或TeX双写时不猜新数值，改用可重放的同实验表或干净连续原句。
16. 每张表严格三选一，不混用正文形态或字段：
   - selection：正文独占 `[[TABLE_<tableIndex>]]`，不写该表Markdown；绑定项只含 `tableIndex` 和 `selection:{sourceTableOrdinal,sourceRows,sourceColumns}`。只选证据实际给出的零基行列，sourceRows首项为明示表头行，之后为数据行；行列不可重复或越界。代码渲染原表、映射和SHA。marker编号是正文表序，不是原表ordinal；不得附带手写值、sourceType、cellBindings或sourceQuotes。
   - artifact_table（既有兼容模式）：在sections[].body写完整 Markdown 表，不使用 TABLE marker；绑定项恰含 `tableIndex,sourceType,sourceTableOrdinal,cellBindings,sourceQuotes`，sourceType为artifact_table、sourceQuotes为空数组。每个cellBindings项恰含 `renderedRow,renderedColumn,sourceRow,sourceColumn` 四个坐标，完整逐格映射。
   - source_quotes：在sections[].body写完整 Markdown 表，不使用 TABLE marker；绑定项恰含 `tableIndex,sourceType,sourceTableOrdinal,cellBindings,sourceQuotes`，sourceType为source_quotes、sourceTableOrdinal为null，`cellBindings=[]` 必须为空，sourceQuotes是全文逐字连续原句的字符串数组。不得发明 `value`、`quoteIndex`、renderedText等字段；quote只验源，不生成表格。
   source_quotes的每个数字单元格须由quote覆盖其全部数字和单位。原文数值带单位时，单位留在同一单元格，不能拆成独立列再期待跨列补全；原文是裸数值时不擅自添单位，指标单位按原文在表头或相邻说明中交代。格式示例：正文 `| 条件 | 指标 | 基线 | 本方法 | 比较对象 |\n| --- | --- | --- | --- | --- |\n| [原文条件] | [指标名] | [原值及单位] | [原值及单位] | [原文对象] |`；绑定 `{"tableIndex":1,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],"sourceQuotes":["[覆盖这些数字与单位的原文连续句]"]}`。方括号是格式占位，不得照抄；正文不再放TABLE marker。
17. 每个正文表都有tableBindings，每个展示公式都有formulaBindings；不得自行填SHA或DOM身份。原文确实无对应证据时相应数组可为空，但自己整理的表仍需quote绑定。保留正确的图/公式ordinal、概念桥marker与绑定关系；修订不为改一处事实重排无关章节或重新编号。

只输出一个合法 JSON 对象，不要 Markdown fence、前言或结尾。字段必须精确如下：

{
  "version": 3,
  "readerTitle": "一个论文特有、能表达中心矛盾或技术判断的中文标题",
  "oneSentenceThesis": "用一句话写清问题、方法选择、最强证据和主要代价",
  "conceptBridges": [
    {
      "terms": ["术语 A", "术语 B"],
      "sectionKind": "component",
      "marker": "[[CONCEPT_BRIDGE_1]]",
      "explanation": "[直接解释术语A与术语B的分工、搭配理由和组合机制，不照抄此占位说明]"
    }
  ],
  "figurePlacements": [
    {
      "figureOrdinal": 1,
      "targetKind": "method_overview",
      "marker": "[[FIGURE_1]]",
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
  "sections": [
    {
      "kind": "background",
      "heading": "为什么这个任务不是把声音丢给模型就结束？",
      "body": "完整、连续、面向初学者的段落"
    }
  ]
}

`sections` 数量遵守本次机械契约，`kind` 只能按需要从以下集合中选择，并且总体按列表顺序递进：

background / related_work / problem / method_overview / component / training / experiment_setup / result / ablation / limitation / reproduction / synthesis

必须覆盖：background、related_work、method_overview、training、experiment_setup、result、limitation、reproduction、synthesis。`training` 不代表一定存在神经网络训练：没有训练时，该节必须明确说明没有训练阶段，并讲清 PCA/SVD、优化器、规则、检索、仿真或既有模型推理的真实计算过程。理论、综述、数据集论文可以用等价的构造、证明、检索或标注流程承担方法职责。

`conceptBridges` 数量遵守本次机械契约。每项的 `terms` 必须恰有 2 个真实论文术语；`marker` 必须按数组顺序严格写成 `[[CONCEPT_BRIDGE_1]]`、`[[CONCEPT_BRIDGE_2]]` 等，并在对应 `sectionKind` 正文中独占一个段落；`explanation` 必须同时出现两个术语，并明确写出各自分工、搭配原因与组合意义，不能只是“二者结合效果更好”。代码会在该位置用 explanation 替换 marker。

`figurePlacements` 质量优先，允许为空且最多 4 项。只能选择请求末尾“模型本次真正收到像素”的 Figure；只出现在 `READER_ARTIFACTS` 图注、但没有收到像素的 Figure 不得选择。不要为了凑数量加入重复曲线、界面截图或装饰图。每个 `figureOrdinal` 只能出现一次。`marker` 必须严格写成 `[[FIGURE_<figureOrdinal>]]`，并在目标小节正文中独占一个段落；`targetKind` 必须等于实际包含 marker 的小节 kind，不要照抄示例的 method_overview，结果曲线通常属于 result/ablation。marker 的前一段必须是完整图前导读，后一段必须是针对可见内容的完整解释。`focusPoints` 必须有 2–4 个针对该图可见元素的观察动作。代码会把 marker 替换成看图路径与官方原图。

`tableBindings` 的 `tableIndex` 从 1 开始，严格对应最终正文第几张表。选择模式的 `sourceRows[0]` 必须来自证据明示的 `TABLE_<ordinal>_HEADER_ROWS`；`SHAPE` 给出矩阵尺寸，`role: unknown` 表示科学用途尚未判定，作者/机构表不可当成结果表。只选矩阵实际呈现的行列，不猜被预算省略的内容。手写映射中 `renderedRow=0` 是表头，`renderedRow=1` 是第一条数据行，分隔行不计数；`sourceRow/sourceColumn` 是原矩阵零基坐标。rowspan/colspan 覆盖位置仍指向被覆盖的矩阵坐标，代码反查真实 DOM cell，每个渲染单元格必须恰好绑定一次。

`formulaBindings` 只绑定 `READER_ARTIFACTS` 中 recovery 完整且含原始 TeX 的公式。`marker` 必须严格为 `[[FORMULA_<formulaOrdinal>]]`，在 `targetKind` 小节独占一个段落且只出现一次；代码会替换成原始 `\[TeX\]` 并绑定 DOM SHA。
~~~
