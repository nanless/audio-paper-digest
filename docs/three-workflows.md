# 三流程与共享核心

只有日更、官方会议、历史博客更新三条生产流程。新任务均调用当前公共引擎与 Prompt；来源和页面范围的差异通过适配器保留，不能伪装成 arXiv 身份。

## 从哪里进入

| 流程 | 获取/范围 | 分析/恢复 | 生成与发布 |
|---|---|---|---|
| 日更 | `run-daily-digest.sh` → `scripts/full-fetch.js` | `analysis-engine.js`；`deep-analysis-only.js`、`batch-analyze.js`、`refresh-api-reader.js` | `generate-blog.py`、`review-blog.py`、`push-blog.py` → `publish-to-blog.py` |
| 官方会议 | `official-conference-acquire.js`、`conference-discover.js`、`conference-filter-run.js` | `conference-process.js` → `lib/conference-analysis-adapter.js` → 同一 `analysis-engine.js` | `conference-page-render.py`、`publish-conference.py` |
| 历史更新 | `history-inventory.py`、`historical-direct-rewrite-inputs.js`、`historical-direct-rewrite-plan.js`、来源准备 | `historical-direct-rewrite-run.js` → `lib/historical-direct-rewrite-runner.js` → 同一引擎；`history-resume.js` | `historical-page-render.py`、`lib/historical-direct-publication.js` |

## 三条流程共用什么

| 职责 | 权威代码 | 要保留的规则 |
|---|---|---|
| 分析编排、锁、检查点、费用与恢复 | `scripts/analysis-engine.js`、`scripts/deep-analyzer.js` | 同篇锁内重读合并，原稿、失败与费用保留 |
| 网络与模型 | `utils.js`、`llm-account-pool.js`、`publish_common.py` | Muse/arXiv 强制代理，只有声明的账号额度故障可向后切号 |
| 全文、表格、公式、作者和资源身份 | `lib/fresh-analysis-context.js`、`lib/reader-*`、`reader_sealed_pdf_*.py` | 来源 SHA、结构化单元格、原始 TeX、真实像素、作者逐项身份与资源可达状态 |
| Reader 写作与局部修复 | `deep-analyzer.js`、`lib/reader-contract.js`、`reader-repair.js`、`reader-draft-order.js` | 同一长文结构、术语机制解释、来源绑定、受限修复预算 |
| 资源宣称 | `deep-analyzer.js` 的共享资源规则与发布只读重放 | 代码可访问不等于权重可下载；否定、条件、第三方引用与本文发布声明区分；新阶段绑定 reader-resource-availability-claims-v1 |
| 评分与标签 | `analysis-contract.js`、`lib/tag-stage-record.js`、`tag_stage_record.py`、`tag_catalog.py` | 八维评分、封顶总分、当前中文标签与明确主任务/方法 |
| 页面展示与引用导出 | `publish-to-blog.py`、`paper_reader_presentation.py` | 同一资源去重、作者展示、评分说明及 JSON/BibTeX/RIS/上下文导出；会议使用真实会议身份 |
| 实现指纹 | `lib/workflow-implementation-files.js` | 收录共享模块和 Python worker 的传递依赖；当前 Prompt 只由版本登记表选取 |
| 不可变文件与页面暂存 | `lib/publication-file-primitives.js`、`lib/paper-page-staging.js` | inode/单链接/目录、严格 UTF-8、SHA 回读和精确路径守卫 |
| 发布与审查 | `publish-to-blog.py`、`publish_common.py`、流程发布适配器 | 内容 SHA 审查复用、事务锁、精确文件清单、远端 OID、部署与网页核验 |

`lib/reader-*` 分成来源、表格、修复和恢复等模块是职责拆分；它们仍由公共引擎调用，不能因文件多而删掉守卫。

## 必须保留的适配差异

日更封存本次官方 arXiv HTML/PDF；会议核验官方版本、会议 ID、账本和 PDF。只有 PDF 的来源不能声称有 HTML DOM 表格或公式能力，已授权的单一替代 PDF 例外仍受白名单限制。

历史按冻结页面范围去重，同篇论文只分析一次，再生成对应历史页面；保留的会议元数据/PDF须核验，arXiv按历史来源策略重新获取。无独立摘要或公开来源 URL 时，导出资料明确标为本次发布元数据不可得，不生成假 arXiv 链接或私有文件路径。

三者共用内容审查函数，但页面集合、来源账本和 Git 基线不同，仍需各自清单与审查凭证；不能复用不属于当前范围的凭证。

## Prompt 的唯一选择入口

`scripts/lib/prompt-text-versions.js` 登记各阶段当前版本。三流程通过公共分析引擎选取同一份主分析、审校、评分、Reader 和局部修复 Prompt；当前文件及用途见 [Prompt 索引](../prompts/README.md)。筛选和页面审查保留各自任务上下文，共用网络、模型路由与请求封装。

旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。新请求只读取当前登记的 18 份 Prompt。

旧资源协议记录仅按其声明只读核验，不补签新合同；当前出版总是按最新资源规则对封存来源重放，缺少版本字段不能绕过。

## 已收敛的旧链

整批 Manual v5/v6/shadow 作者、任务、spec 与 records 链，以及微信、飞书、小红书、旧 backfill、隔离 Reader 效率实验和视觉调试渲染已退役。

会议独立 execution/analyze/postprocess CLI 已删除，统一走 `conference:process`。历史旧独立分析、标签、暂存、汇总、发布 CLI 和旧整批重写 CLI 已删除，统一走当前历史计划与 `history:resume`。

`manual/` 的剩余源码仅为旧记录来源/签名/正文核验，以及独立单页人工审查。旧历史核心中仍被受限恢复入口调用的部分保留，不允许重新建立旧任务或重置预算。单篇人工修正与审查是三流程的恢复能力。

## 操作与验证文档

- [操作手册](../SKILL.md)、[会议流程](conference-workflow.md)、[历史更新](history-rewrite.md)、[历史发布](history-direct-publication.md)。
- [安装配置](setup.md)、[来源补抓边界](daily-fetch-boundary.md)、[Reader 写作](reader-writing.md)、[恢复预算](reader-explicit-retry.md)。
- [数据格式](data-format.md)、[标签规则](tag-display-policy.md)、[维护验证](maintenance.md)、[故障排查](troubleshooting.md)。
