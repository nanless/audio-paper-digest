# Prompt 索引

工作树只保存下列 18 份当前正文与本索引。15 份通用阶段模板（含筛选）由 `scripts/lib/prompt-text-versions.js` 登记，另 3 份受控修复模板由公共引擎在对应模式下选择；运行时读取第一个围栏代码块，不能凭文件名版本号大小自行选取。

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

日更与会议筛选共同使用登记的 `filter-v5.md`，各入口填入对应来源和会议配置；发布审查由公共发布器构建页面上下文，均使用同一公共请求封装。不存在独立会议或历史 Reader 长文 Prompt。普通新请求使用当前模板；旧稿按原声明核验，失败集合续跑还须通过对应候选恢复规则。调度轮次不修改正文协议，不重置已付费候选或补签旧 Prompt 身份。

写作采用[共同约定](../docs/writing-guide.md)与[Reader 说明](../docs/reader-writing.md)：面向入门者讲清概念、一次计算与完整数据流，在结果附近交代比较条件，公式和图表解释具体作用，段落之间留空行。长文、机器分析、受限纠错和视觉规划各守原输出结构；筛选、标签与评分不因语言规范改为自由长文。JSON 正文字符串用合法 `\n\n` 转义表示空行，原表、TeX、引用、字段与标记按各自协议保留。

主分析 v6、Reader v9、局部修复 v13 保留现有讲解与协议要求。核心摘要 v7 只纠正比较证据的说明：同一实验表中，不同方法行的同一指标可以比较，仍须逐项核对完整表头、对象、条件、单位和精度，不能跨指标或条件拼接。上一版核心摘要 v6 及更早的原 Prompt 字节按登记的 Git blob、整文件 SHA 和合同路径核验。升级不自动兼容旧活跃候选，不增加请求额度或恢复许可；仅更改首围栏外的说明也不能当作模型已收到新规则。

主分析和标签修复共用当前386项词表，只输出本篇有证据的直接标签。父级路径由发布器统一推导，不要求模型另写全目录或把祖先放进直接集合；原3–5项、主任务/主方法及JSON/四行结构保持不变。新版目录中的零计数方向仍可在总目录保留，不能因此强行给论文贴标签。

旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。会议旧活跃 Reader 的私有重验范围只有在原请求、响应、用量和认证来源全部闭合且硬禁新模型时，才保留原 Prompt 声明；它不能用于继续付费写作。旧 Manual 模板同样只用于原记录核验，不恢复已退役的生产入口。

历史凭证读取要求 Git 2.45 或更新版本及完整仓库历史；CI 已使用完整检出。读取器禁止自动联网补取对象，也不会把旧正文写回工作树。浅克隆缺少原对象时，先同步完整 Git 历史，再重新核验。
