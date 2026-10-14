# Prompt 索引

工作树只保存下列 18 份当前正文与本索引。14 个通用阶段和筛选按 `scripts/lib/prompt-text-versions.js` 选择，3 个受控修复模板由公共引擎在对应修复模式下选择；运行时读取第一个围栏代码块，不能凭文件名版本号大小自行选取。

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
| 主分析事实局部修复 | [primary-fact-local-repair-v1.md](primary-fact-local-repair-v1.md) |
| Reader 已核验事实原句修复 | [api-reader-fact-local-v3.md](api-reader-fact-local-v3.md) |
| Reader 术语组合列表修复 | [api-reader-concept-terms-v1.md](api-reader-concept-terms-v1.md) |

日更与会议筛选共同使用登记的 `filter-v5.md`，各入口填入对应来源和会议配置；发布审查由公共发布器构建页面上下文，均使用同一公共请求封装。不存在独立会议或历史Reader长文Prompt。全批与失败集合的各轮使用同一当前模板和内容检查；调度轮次不修改正文协议，不重置已付费候选或补签旧Prompt身份。

旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。新请求只读取当前登记的 18 份 Prompt。旧 Manual 模板同样只用于原记录核验，不恢复已退役的生产入口。

历史凭证读取要求 Git 2.45 或更新版本及完整仓库历史；CI 已使用完整检出。读取器禁止自动联网补取对象，也不会把旧正文写回工作树。浅克隆缺少原对象时，先同步完整 Git 历史，再重新核验。
