# Prompt 索引

三流程新任务按 `scripts/lib/prompt-text-versions.js` 选择下列当前文件；运行时读取第一个围栏代码块，不能凭文件名版本号大小自行选取。

| 阶段 | 当前文件 |
|---|---|
| 论文筛选 | [filter-v5.md](filter-v5.md) |
| 全文主分析 | [deep-analysis-v5.md](deep-analysis-v5.md) |
| 审校重写 | [gap-fill-v4.md](gap-fill-v4.md) |
| 资源核验 | [opensource-scan-v3.md](opensource-scan-v3.md) |
| 表格修复 | [table-fill-v2.md](table-fill-v2.md) |
| 方法补全 | [method-fill-v3.md](method-fill-v3.md) |
| 标签 | [tag-repair-v3.md](tag-repair-v3.md) |
| 核心摘要 | [core-summary-repair-v6.md](core-summary-repair-v6.md) |
| 结构修复 | [structure-repair-v3.md](structure-repair-v3.md) |
| 评分 | [scoring-audit-v5.md](scoring-audit-v5.md) |
| Reader长文 | [api-reader-article-v8.md](api-reader-article-v8.md) |
| Reader受限修复 | [api-reader-repair-v12.md](api-reader-repair-v12.md) |
| 图片补充 | [image-supplement-v3.md](image-supplement-v3.md) |
| 长图规划 | [visual-summary-v2.md](visual-summary-v2.md) |
| 封面规划 | [digest-cover-v2.md](digest-cover-v2.md) |

日更与会议筛选共同使用登记的 `filter-v5.md`，各入口填入对应来源和会议配置；发布审查由公共发布器构建页面上下文，均使用同一公共请求封装。不存在独立会议或历史Reader长文Prompt。

旧版本以及 `history/<sha>.md` 是已付费草稿、旧阶段和发布记录的不可变SHA恢复证据。它们不作为新任务写作版本，但当前恢复/旧记录核验仍读取；没有迁移全部绑定前不能删或改字节。`manual/prompts/`与其编辑依据合同也只用于旧记录核验。
