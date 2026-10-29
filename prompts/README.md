# 提示词索引

本目录保存 18 份现用模板及本索引。15 份通用模板（含筛选）由[版本登记表](../scripts/lib/prompt-text-versions.js)选择，另 3 份用于指定范围的事实或术语修复。加载器只读取模板的第一个围栏代码块；实际使用哪一份，以程序登记为准。

按需要查找下表，不必让每篇论文依次执行所有模板。程序根据日更、会议或历史更新流程、保存的进度和实际问题选择阶段。请求次数与费用沿原记录累计，增加调度轮次或切换模板不重置原请求额度。

- **选什么、怎样解释**：筛选、全文主分析、Reader 长文与评分。
- **检查和补足什么**：资源、表格、方法、标签、摘要、结构和 Reader 受限修复。
- **怎样呈现及定向纠错**：图片/长图/封面规划，以及三份只用于已绑定范围的事实或术语修复模板。

| 阶段 | 当前文件 |
|---|---|
| 论文筛选 | [filter-v5.md](filter-v5.md) |
| 全文主分析 | [deep-analysis-v6.md](deep-analysis-v6.md) |
| 审校重写 | [gap-fill-v4.md](gap-fill-v4.md) |
| 资源核验 | [opensource-scan-v3.md](opensource-scan-v3.md) |
| 表格修复 | [table-fill-v2.md](table-fill-v2.md) |
| 方法补全 | [method-fill-v3.md](method-fill-v3.md) |
| 标签 | [tag-repair-v3.md](tag-repair-v3.md) |
| 核心摘要 | [core-summary-repair-v7.md](core-summary-repair-v7.md) |
| 结构修复 | [structure-repair-v3.md](structure-repair-v3.md) |
| 评分 | [scoring-audit-v5.md](scoring-audit-v5.md) |
| Reader长文 | [api-reader-article-v9.md](api-reader-article-v9.md) |
| Reader受限修复 | [api-reader-repair-v13.md](api-reader-repair-v13.md) |
| 图片补充 | [image-supplement-v3.md](image-supplement-v3.md) |
| 长图规划 | [visual-summary-v2.md](visual-summary-v2.md) |
| 封面规划 | [digest-cover-v2.md](digest-cover-v2.md) |
| 主分析事实局部修复 | [primary-fact-local-repair-v1.md](primary-fact-local-repair-v1.md) |
| Reader 已核验事实原句修复 | [api-reader-fact-local-v3.md](api-reader-fact-local-v3.md) |
| Reader 术语组合列表修复 | [api-reader-concept-terms-v1.md](api-reader-concept-terms-v1.md) |

日更与会议筛选共用[筛选模板](filter-v5.md)，各入口填入相应来源和会议配置。三条流程共用 Reader 写作与解析规则；发布审查的页面输入由公共发布器生成，模型请求使用公共请求封装。新请求使用当前模板，旧记录按原声明核验，失败稿从对应的保存进度恢复。

日更 Reader 通过 Responses 修复普通已有字段时，程序还可生成带目标编号（`targetOrdinal`）和短标记（`requestToken`）的运行时提示词，再转换为按原字段 SHA 核验的补丁。特殊修复继续使用各自规则。运行时生成的提示词另记身份和真实请求，目录中的 18 份模板保持原样，原请求额度也不变。

写作采用[共同约定](../docs/writing-guide.md)与[Reader 说明](../docs/reader-writing.md)：面向入门者讲清概念、一次计算与完整数据流，在结果附近交代比较条件，公式和图表解释具体作用，段落之间留空行。长文、机器分析、受限纠错和视觉规划各守原输出结构；筛选、标签与评分不因语言规范改为自由长文。JSON 正文字符串用合法 `\n\n` 转义表示空行，原表、TeX、引用、字段与标记按各自协议保留。

当前主分析使用 v6，Reader 写作使用 v9，局部修复使用 v13，核心摘要修复使用 v7。摘要中的比较可以取自同一原表不同方法行的同一指标，须逐项核对完整表头、对象、条件、单位和精度；不同指标或条件分别说明。旧模板及旧稿仍按原路径、原 Git 对象和原 SHA 核验，版本更新保留旧稿、请求次数、费用和恢复范围。首围栏外的说明供维护者阅读，不会发送给模型。

主分析和标签修复共用当前386项词表，只输出本篇有证据的直接标签。父级路径由发布器统一推导，不要求模型另写全目录或把祖先放进直接集合；原3–5项、主任务/主方法及JSON/四行结构保持不变。新版目录中的零计数方向仍可在总目录保留，不能因此强行给论文贴标签。

## 修改模板与核验旧记录

整理本索引时保留 18 份模板的原字节、字段、输出结构和版本。模板首围栏外的说明也参与整文件身份核验。确需修改模板时，按[提示词修改规则](../docs/maintenance.md#prompt-修改)同步处理版本、登记表、正反例和已有失败稿的恢复；保留原占位符、解析协议及来源要求。

旧模板从 Git 读取，不保存在工作树。[历史证据索引](../scripts/lib/git-prompt-evidence-index.json)登记原路径、Git 对象编号和整文件 SHA。读取器核对整文件与首围栏模板 SHA；原对象缺失或字节不符时停止。原声明、论文来源、保存进度和付费记录继续保留，旧结果只按原模板核验。

会议中尚未完成的旧 Reader，可在原请求、响应、用量及论文来源均核实后只读重验。该入口禁止模型请求，沿用原模板声明。旧 Manual 模板也只供原记录核验，Manual 生产入口已退役。

读取历史证据需要 Git 2.45 或更新版本及完整仓库历史，CI 已使用完整检出。读取器只访问本地原对象。浅克隆缺少对象时，先同步完整历史，再重新核验；旧模板不写回工作树。
