# 脚本完整文件索引（自动生成）

本文件由 `node scripts/generate-scripts-index.js` 根据 `scripts/` 目录自动生成，列出全部受版本控制的 `.js` 与 `.py` 运行时文件。
架构分工与常用入口见 [脚本指南](README.md)（[English](README.en.md)）；旧记录兼容与独立人工审查位于 `manual/scripts/`。

总计：**475** 个运行时文件（顶层 Node 91 · 顶层 Python 97 · `lib/` 内部库 287）。

## 顶层 Node 入口与共享模块（91）

| 文件 | 职责摘要 |
|---|---|
| `activate-fresh-publication.js` | Node 流程入口或共享模块 |
| `analysis-contract.js` | Node 流程入口或共享模块 |
| `analysis-engine.js` | Node 流程入口或共享模块 |
| `analysis-waiver.js` | Node 流程入口或共享模块 |
| `arxiv-source-authority.js` | Node 流程入口或共享模块 |
| `batch-analyze.js` | Node 流程入口或共享模块 |
| `calibrate-batch-scores.js` | Wave 14.4 CLI: Post-Batch Swiss-Tournament Bradley-Terry Relative Score Calibration. |
| `compact-papers-ledger.js` | Safe lossless compaction CLI for data/current/papers.json (Wave 14.6A). |
| `conference-discover.js` | 根据已有本地文件寻找来源候选，匹配结果仍须核验。传入 --apply 时， |
| `conference-filter-evidence.js` | Node 流程入口或共享模块 |
| `conference-filter-run.js` | Node 流程入口或共享模块 |
| `conference-filter.js` | 受控的本地 CLI，用来准备、查看和应用已经做出的会议筛选决定。没有任何命令会调用 |
| `conference-import.js` | 生产环境的会议导入只接受一份暂存清单和它的已核验凭证，并重新核对筛选与发现的 |
| `conference-plan.js` | 只有在发现、筛选、暂存、导入这条凭证链完整时才创建 run。所有 CLI 文件参数都必须 |
| `conference-process.js` | Node 流程入口或共享模块 |
| `conference-queue.js` | Node 流程入口或共享模块 |
| `conference-staging.js` | 从一份已审阅的本地提取规格生成不可变、绑定筛选结果的导入清单。它不导入或复制 |
| `conference-tools.js` | 私有会议来源状态的只读维护命令。它们有意只接受配置的运行根目录下的直接 JSON |
| `conference-workspace.js` | 会议工作区的只读维护诊断。 |
| `config-check.js` | 只读检查项目 .env：必填、类型、范围与未知变量。不写文件、不打印密钥值。 |
| `config.js` | 音频研究工作台的公共配置：路径、抓取、筛选、分析和发布参数。 |
| `deep-analysis-only.js` | Node 流程入口或共享模块 |
| `deep-analyzer.js` | Node 流程入口或共享模块 |
| `digest-run-report.js` | Node 流程入口或共享模块 |
| `digest-scorecard.js` | 只读 LLM 运行记分卡（Wave 11 Track 11C）。 |
| `digest-status.js` | Node 流程入口或共享模块 |
| `docs-consistency.js` | 检查文档里的 npm 命令、客户端版本声明、链接与锚点、双语索引、废弃写法、环境变量、env.example 同步及 AGENTS.md 体积。 |
| `doctor.js` | 音频研究工作台只读体检命令。 |
| `editorial-quality.js` | 项目规定：scripts/*.js 里每个可直接执行的脚本，都要在沙箱里做任何事之前先失败退出。 |
| `env-loader.js` | Node 流程入口或共享模块 |
| `evaluate-keyword-prefilter.js` | Node 流程入口或共享模块 |
| `export-review-failure-manifest.js` | 为两种必须手写、没有生成器的 JSON 清单导出只读骨架： |
| `fetch-huggingface-papers.js` | Node 流程入口或共享模块 |
| `fetch-papers.js` | Node 流程入口或共享模块 |
| `full-fetch.js` | Node 流程入口或共享模块 |
| `generate-scripts-index.js` | 自动生成 scripts/INDEX.md，供维护者与 tests/scripts-index.test.js 查验脚本全集。 |
| `historical-arxiv-batch.js` | Node 流程入口或共享模块 |
| `historical-arxiv-publication-metadata.js` | Node 流程入口或共享模块 |
| `historical-conference-local-sources.js` | 只做本地来源收集。这条命令不依赖来源对照、网络、LLM、重写、发布或博客页面。 |
| `historical-conference-page-projections.js` | Node 流程入口或共享模块 |
| `historical-direct-aggregate.js` | Node 流程入口或共享模块 |
| `historical-direct-control.js` | Node 流程入口或共享模块 |
| `historical-direct-publication.js` | Node 流程入口或共享模块 |
| `historical-direct-rewrite-inputs.js` | Node 流程入口或共享模块 |
| `historical-direct-rewrite-plan.js` | Node 流程入口或共享模块 |
| `historical-direct-rewrite-run.js` | history:sources 只准备来源文件，不调用模型； |
| `historical-direct-rewrite-scheduler.js` | 这个入口只准备来源队列。它绝不触发分析、Reader、渲染、来源对照改动、博客生成 |
| `historical-direct-tag-supplement.js` | Node 流程入口或共享模块 |
| `historical-icml-alternate-pdf-source.js` | Node 流程入口或共享模块 |
| `historical-openreview-pdf-source.js` | Node 流程入口或共享模块 |
| `historical-outdated-audit.js` | 只读扫描博客仓库 content/posts/ 下的历史文章 frontmatter， |
| `historical-source-identity-supplement.js` | Node 流程入口或共享模块 |
| `historical-source-tag-assignment.js` | Node 流程入口或共享模块 |
| `historical-tag-checkpoint-export.js` | Node 流程入口或共享模块 |
| `history-conflict-identity.js` | Node 流程入口或共享模块 |
| `history-resume.js` | 旧运行的唯一恢复入口。只读取已保存运行，不创建新来源或重置尝试预算。 |
| `impact.js` | 静态反向依赖图、协议/渲染指纹闭包识别与受影响单测执行器（默认只读；--run-tests 串行跑受影响单测）。 |
| `llm-account-pool.js` | OpenCode Go 账号池的共享状态实现。 |
| `llm-accounts-quota.js` | OpenCode Go 多账号月/周/5小时额度与到期日管理 CLI。 |
| `llm-accounts-report.js` | 只读区分当前配置与历史观察；不发请求、不刷新额度、不改状态。 |
| `llm-usage-report.js` | Node 流程入口或共享模块 |
| `locks.js` | 有界只读观测；--recover 仅预览。此结果不授予持锁、发布或回收权限。 |
| `log-setup.js` | Node 流程入口或共享模块 |
| `manifest-new.js` | Node 流程入口或共享模块 |
| `migrate-conference-process.js` | 会议流程的实现指纹变了以后，用它做一次显式迁移，过程留痕。已完成的论文先按当前 |
| `official-conference-acquire.js` | Node 流程入口或共享模块 |
| `page-source-crosswalk.js` | Node 流程入口或共享模块 |
| `prepare-daily-fetch-witness-recovery.js` | Node 流程入口或共享模块 |
| `publish-daily-podcast.js` | Node 流程入口或共享模块 |
| `publish-finish.js` | push 成功后的收尾清单：提示日更不生图登记与最终核验；不调用图像 API、不自动登记豁免。 |
| `reanalyze-selected.js` | Node 流程入口或共享模块 |
| `reanalyze.js` | Node 流程入口或共享模块 |
| `recover-conference-process-locks.js` | Node 流程入口或共享模块 |
| `recover.js` | 只读恢复决策：读当前失败集，按错误码给出唯一建议入口与可复制命令。 |
| `refresh-api-reader.js` | Node 流程入口或共享模块 |
| `review-overrides-cli.js` | 只读核对审查误报记录：校验 schema、匹配失败页 SHA 与逐字 claim，报告可降级数量；不修改审查结果。 |
| `runtime-storage.js` | Node 流程入口或共享模块 |
| `source-probe.js` | 只读探测 arXiv Atom/官方 OAI/RSS 三个入口，不抓取、不写 data/current。 |
| `storage-report.js` | 存储保留建议：只读。显示 storage:status 概览，并按类别给出“必须保留/可压缩/可删”的建议。 |
| `table-check.js` | 离线表格预检：输入草稿 JSON（含 sections[].body）或 Markdown 文件，报告粘连复写、 |
| `tag-check-inventory.js` | 更新词表前，读取会议、日更分析和历史分类文件中的标签阶段记录，并按词表 SHA 分组。 |
| `tag-record-update.js` | 词表更新后，检查已有标签阶段记录能否继续沿用，并计算或写入更新结果。 |
| `tag-tools.js` | Node 流程入口或共享模块 |
| `test-api-key.js` | Node 流程入口或共享模块 |
| `utils.js` | Audio Research Workbench 公共工具模块 |
| `validate-data-files.js` | Node 流程入口或共享模块 |
| `verify-project.js` | 这个运行器有意不引入分析或发布模块，也不做网络设置。 |
| `verify-web.js` | 发布后网页核验： |
| `waive-analysis-failures.js` | Node 流程入口或共享模块 |
| `waive-post-publish-visuals.js` | 按用户持续要求，登记本次发布不生成图片。 |
| `workspace-role.js` | Node 流程入口或共享模块 |

## 顶层 Python 入口与共享模块（97）

| 文件 | 职责摘要 |
|---|---|
| `analysis_quality_format.py` | Select the original or current quality rules without changing the source record. |
| `analysis_sections.py` | 识别论文评价的章节标题，兼容旧标题而不改写原文。 |
| `arxiv_tex_extract.py` | Safe arXiv /e-print/<id> TeX source archive unpacker and AST extractor. |
| `blog_entry_loader.py` | 以共享实现模块的方式加载 publish-to-blog.py。 |
| `blog_formula_tex_display.py` | 展示公式 CommonMark/GFM 切分、Markdown 表格提取与表格单元格 TeX 显示投影。 |
| `blog_git_publication.py` | 博客 Git 发布事务、索引与提交树精确字节校验、回滚快照与远端 OID 验证。 |
| `blog_reader_binding_verifier.py` | API Reader 数值/单位/引文投影、图表/SVG/PDF 资产解析、DOM/PDF 表格绑定与页面绑定核验。 |
| `blog_record_format.py` | Select published or historical blog layouts from their real header. |
| `blog_repository_lock.py` | 博客 Git 仓库各写入方共用的锁，绑定到 inode。 |
| `blog_review_image_loader.py` | 多模态博客审查安全取图、公网固定 IP 抓取与无网隔离 SVG 光栅化。 |
| `blog_review_state.py` | 博客审查状态账本：审查凭证读写校验、通过缓存、逐页检查点、失败状态与增量审查计划。 |
| `blog_tag_catalog.py` | 标签受控词表快照、版本目录、展示策略、确定性序列化缓存与页面标签投影。 |
| `build-tag-preview.py` | 根据历史博客元数据生成私有标签预览，不改写论文页面。 |
| `conference_extractor_v2.py` | 会议 PDF 增强型确定性本地抽取器（Wave 13 Track 13.2 Companion v2）。 |
| `conference_extractor.py` | 对暂存的会议 PDF 做本地确定性抽取。 |
| `conference_publication_figure_crop.py` | Deterministic publication pixels; never Reader/model-input authority. |
| `conference_publication_figure_view_replay.py` | Pure read-only view transform; output is NEVER source/review/publication authority. |
| `conference_publication_figure_view.py` | Immutable publication-only figure views. |
| `conference_publication_gate.py` | 对 HTML 与已部署 URL 做机械检查，不涉及语义或视觉判断。 |
| `conference_source_correction_format.py` | Identify source-correction record formats before the actual local replay. |
| `conference-extract.py` | 对已暂存的一篇会议 PDF 做文本与视觉审计抽取，产物不再改动；这是它的命令行入口。 |
| `conference-filter-evidence-extract.py` | 按工作区角色放行的适配层，在证据项根目录里调用现有的确定性抽取器。 |
| `conference-page-render.py` | 根据已核验的来源记录生成会议论文页面，不为会议论文添加 arXiv 身份。 |
| `core_summary_format.py` | Read the declaration and the stage header without altering saved proof bytes. |
| `daily_deployment_store.py` | Bounded append-only mechanical deployment records; never normal authority. |
| `daily_html_projection.py` | Finite mechanical static HTML projection, with no Source or publication authority. |
| `daily_hugo_capture.py` | Keep mechanical HTML observations from the original normal Hugo invocation. |
| `daily_observed_projection.py` | Derive bounded static observations through the original daily review owner. |
| `daily_republication.py` | 显式退休已发布日批的活动发布凭证，保留原字节并恢复正常生成/审查。 |
| `daily_source_format.py` | Select an actual sealed daily source run or reference layout. |
| `generate-blog.py` | 只生成博客 Markdown 并保存为文件；不审查、不提交、不推送。 |
| `git_file_bytes.py` | Read exact file/Git bytes without executing them or granting workflow authority. |
| `github_pages_deployment.py` | Fixed, anonymous Pages metadata observations, never publication authority. |
| `historical_page_scan.py` | 只读盘点历史 Hugo 页面，并保存扫描结果与配对凭证。 |
| `historical-direct-review.py` | 检查单批历史页面的正文及图片，保留进度以便失败后继续。 |
| `historical-page-render.py` | 根据历史论文记录及其来源证明生成单篇论文页面。 |
| `history-inventory.py` | 生成历史页面清单及对应凭证的命令行入口；页面来源只读。 |
| `icmc-proceedings.py` | 拆分 ICMC 2026 官方会议论文集 PDF。 |
| `indextts_synth.py` | Wave 14.3: Pluggable IndexTTS latest (IndexTTS-2.5 / 2.0 / v1) podcast synthesizer. |
| `llm_account_pool.py` | Python 调用方使用的跨进程 OpenCode Go 账号池。 |
| `llm_usage_format.py` | 只识别用量事件的原格式；不更改原账目或授予请求额度。 |
| `llm_usage.py` | 记录模型请求的用量、状态与摘要，不保存请求或响应正文；格式与 lib/llm-usage.js 一致。 |
| `local_git_commit_delta.py` | Bounded B/C directory-tree and expected-file facts, never publication proof. |
| `local_git_object.py` | Fixed offline raw Git object observations; never Source/publication proof. |
| `local_git_publication.py` | Finite local HEAD/remote configuration observations, never publication authority. |
| `log_setup.py` | Python 流程脚本或共享模块 |
| `manual_agent_policy.py` | 按外层记录的版本核对人工审查身份；旧身份只供读取原记录。 |
| `markdown_hugo_gate.py` | 教程页面的 Markdown 格式与 Hugo 渲染检查。 |
| `original_file_evidence.py` | Return registered original bytes; never execute code or grant source/completion authority. |
| `paper_identity.py` | 跨运行时读取论文身份，保留原记录的格式和身份摘要。 |
| `paper_reader_presentation.py` | Shared Reader presentation after each workflow authenticates its source records. |
| `parse-arxiv-atom.py` | 严格解析抓取阶段的 Atom 响应，只向标准输出写入结构化 JSON。 |
| `path_config.py` | Python 侧共用的项目路径，以及确保文件内容完整保存的写入辅助函数。 |
| `pdf_author_extract_v1.py` | 从已封存论文 PDF 第 1 页的字体与上标几何结构中确定性提取作者与机构绑定。 |
| `pdf_author_extract.py` | 从已封存论文 PDF 第 1 页的字体与上标几何结构中确定性提取作者与机构绑定。 |
| `pdf_figure_table_extract.py` | Deterministic PyMuPDF figure-bbox and table extractor for sealed PDF sources. |
| `pdf-layout-extract.py` | 只有 PDF 的论文来源共用的 PyMuPDF 抽取逻辑。 |
| `project_env.py` | 项目内环境变量加载器。 |
| `prompt_evidence.py` | Read current templates or SHA-pinned retired Git evidence, without writes/network. |
| `protocol_codec.py` | 识别当前和历史格式；不修改原对象，也不授予分析或发布资格。 |
| `public_network_policy.py` | 公网 IP / CIDR 与代理 Fake-IP 安全策略（与 Node `lib/public-network-policy.js` 单源同构）。 |
| `publication_activation.py` | 将旧发布状态文件归档，让新的正式分析结果能重新生成和发布；中断后可恢复。 |
| `publication_local_replay.py` | Private, invocation-local transport evidence for read-only publication workers. |
| `publish_common.py` | Audio Research Workbench 发布公共模块 (Python) |
| `publish_node_replay_client.py` | Thread-safe persistent Node JSON-RPC client for read-only publication replay CLIs. |
| `publish-conference.py` | 把一个已完成的会议流程作为独立的博客增量发布出去。 |
| `publish-to-blog.py` | Python 流程脚本或共享模块 |
| `push-blog.py` | 推送已审查的博客页面，核对远端提交。 |
| `reader_authenticated_pdf_footnote_evidence.py` | Literal author-release footnotes from authenticated PDF bytes; no URL fetching. |
| `reader_authenticated_pdf_hierarchical_table.py` | Complete, uniquely located PDF header hierarchies; no HTML/DOM authority. |
| `reader_damaged_raster_pdf_asset.py` | Explicit single-target publication recovery of a structurally truncated PNG. |
| `reader_grouped_vector_column_units.py` | Complete DOM/PDF vector-grid unit coverage, mirrored from the normal Reader. |
| `reader_inline_svg_pixel_replay.py` | Reproduce saved model pixels using only this checkout's trusted Git renderers. |
| `reader_inline_svg.py` | 把无外部资源的官方内联 SVG 转成当前调用使用的真实像素。 |
| `reader_pdf_cell_evidence.py` | 依照封存 PDF 原字形与表格位置逐格核验数值双写，不修改原来源。 |
| `reader_pdf_column_unit_projection.py` | Stable envelope around a freshly extracted, byte-identified column proof. |
| `reader_pdf_page_asset.py` | Publication-only whole-page assets from the same four sealed daily sources. |
| `reader_pdf_page_geometry.py` | Pure shared PDF page geometry: no daily/conference identity or permission. |
| `reader_pdf_quote_projection.py` | Encode source-derived PDF quotes without changing the extraction algorithm. |
| `reader_pdf_visual_audit_cache.py` | Bounded process-local cache of successful pure PDF visual extraction. |
| `reader_proof_format.py` | Choose an exact proof representation; never authenticate source or values. |
| `reader_record_format.py` | Read current and original Reader metadata without granting source authority. |
| `reader_sealed_pdf_column_units.py` | Independent full PDF matrix geometry for column units; never a prose-unit inference. |
| `reader_sealed_pdf_literal_column_units.py` | Independent complete PDF grids for daily column units; no DOM projection. |
| `reader_sealed_pdf_quote_evidence.py` | Exact continuous PDF quotations, with a separate origin from HTML text. |
| `reader_sealed_pdf_table_evidence.py` | Generic exact PDF grid evidence; PDF display values retain their own origin. |
| `review-blog.py` | 严格审查已生成的博客清单，并保存哈希核验记录。 |
| `runtime_guard.py` | 需要宿主机联网的命令共用的运行时前置检查。 |
| `scoring_record_format.py` | 读取评分记录原有或现用的完整格式头；不代替来源、正文和费用核验。 |
| `scoring_rubric_v2.py` | Shared Python engine for scoring rubric `type-aware-v2`. |
| `scoring_stability.py` | Strict read-only scoring proof predicate, mirrored by lib/scoring-stability.js. |
| `tag_catalog_publication.py` | 只读核验发布页面所绑定的标签词表已完整安装在博客中。 |
| `tag_catalog.py` | 读取并核验标签词表，按指定规则查找标签对应的概念。 |
| `tag_paths.py` | 集中定义标签词表和私有预览的路径。 |
| `tag_presentation.py` | 只将实际命中的受控标签投影为分类路径，不为论文追加上位标签。 |
| `tag_stage_record.py` | 识别标签阶段的保存格式，返回原记录及其哈希绑定字段。 |
| `utils.py` | Audio Research Workbench 公共工具模块 (Python) |

## 内部支撑库（`scripts/lib/`）（287）

| 文件 | 职责摘要 |
|---|---|
| `lib/active-time-budget.js` | Shared active-time accounting; long stalls may be system suspend or local event-loop blockage. |
| `lib/analysis-batch-report.js` | Node 内部共享支撑模块 |
| `lib/analysis-failure-rounds.js` | Node 内部共享支撑模块 |
| `lib/analysis-quality-format.js` | Node 内部共享支撑模块 |
| `lib/analysis-section-titles.js` | 新分析使用“论文评价”。旧标题只用于识别保存的正文，不改写原文。 |
| `lib/analysis-stage-request-guard.js` | Node 内部共享支撑模块 |
| `lib/analysis-stop-control.js` | Node 内部共享支撑模块 |
| `lib/analysis-terminal-summary.js` | Node 内部共享支撑模块 |
| `lib/analysis-text-profile.js` | Node 内部共享支撑模块 |
| `lib/arxiv-html-structured-artifacts.js` | Node 内部共享支撑模块 |
| `lib/arxiv-metadata-source.js` | Node 内部共享支撑模块 |
| `lib/arxiv-origin-gate.js` | 进程内全局 arXiv 源站并发与共享 Retry-After 冷却门禁。 |
| `lib/arxiv-source-authority.js` | 保存官方 arXiv 抓取结果，供历史 paper-source-authority 来源核验读取。 |
| `lib/arxiv-tex-source.js` | arXiv /e-print/<id> TeX Source Channel Fetcher & Sidecar Manager (Wave 14.1) |
| `lib/blog-record-format.js` | Node 内部共享支撑模块 |
| `lib/bradley-terry-calibration.js` | Wave 14.4: Post-Batch Swiss-Tournament Bradley-Terry Relative Score Calibration. |
| `lib/cancelled-reader-audit-recovery.js` | Node 内部共享支撑模块 |
| `lib/cancelled-reader-final-checkpoint.js` | Node 内部共享支撑模块 |
| `lib/cli-arguments.js` | 入口参数白名单。batch/reanalyze 曾静默忽略未知 --flag：例如把 |
| `lib/completed-bound-fact-feedback.js` | Node 内部共享支撑模块 |
| `lib/completed-reader-upstream.js` | Node 内部共享支撑模块 |
| `lib/conference-analysis-adapter.js` | Node 内部共享支撑模块 |
| `lib/conference-analysis-context.js` | Node 内部共享支撑模块 |
| `lib/conference-complete-stage-pool.js` | Pure completed-paper staging only. The caller keeps the process operation |
| `lib/conference-complete-stage-worker.js` | Private backend for the locked migration's pure completed-page pass. |
| `lib/conference-discovery.js` | 针对不可变的会议元数据快照和本地 PDF 目录做离线发现。发现阶段只提出来源候选： |
| `lib/conference-execution.js` | 记录已导入会议计划的执行状态。读取或更新前，核对权限凭证、 |
| `lib/conference-extraction-receipt.js` | 在进入会议暂存之前，核对 Python 从 PDF 抽取的结果。抽取器可能附上从官方 |
| `lib/conference-filter-evidence.js` | 为会议筛选做离线、不可变的证据准备。本模块按设计不分类论文，也不调用 LLM。它把 |
| `lib/conference-filter.js` | 保存会议筛选状态并验证运行所用的来源记录。此模块不读取 data/current，也不发布； |
| `lib/conference-importer.js` | 离线、按清单导入本地会议来源素材。清单声明权威的会议身份，以及每个允许的来源 |
| `lib/conference-pdf-source.js` | 从已核验的本地 PDF 及可选提取结果整理来源记录，也支持已加载并核验的会议来源清单。 |
| `lib/conference-plan.js` | 根据已审会议计划和来源账本创建运行记录，逐项核验论文身份与输入文件。 |
| `lib/conference-postprocess.js` | Node 内部共享支撑模块 |
| `lib/conference-process-recovery.js` | Node 内部共享支撑模块 |
| `lib/conference-process.js` | 统一管理新获取的官方会议论文。论文只有完成分析凭证核验、生成页面清单， |
| `lib/conference-publication-author-replay-cli.js` | 仅固定配置根及私有FD的本地来源重放，网络/模型禁用。 |
| `lib/conference-publication-author-source.js` | 发布只读回放已有来源；不建立新来源、重抽 PDF 或加载模型配置。 |
| `lib/conference-publication-figure-crop-replay-cli.js` | Normal-publisher private FD bridge, never a model / network entry. |
| `lib/conference-publication-figure-crop.js` | Publication display derivations only. No Reader or process writes, |
| `lib/conference-queue.js` | 队列安排各会议的执行顺序，并保存进度；来源证据和操作锁由 process、publisher 管理。 |
| `lib/conference-reader-active-candidate-replay.js` | Node 内部共享支撑模块 |
| `lib/conference-reader-operator-apply.js` | Local Reader corrections use the normal parser and full qualification. They |
| `lib/conference-reader-operator-correction.js` | Explicit human edits are source-bound local operations, never model responses |
| `lib/conference-reader-pdf-identity.js` | Node 内部共享支撑模块 |
| `lib/conference-reader-publication-evidence.js` | 只为当前出版补充原 PDF 的逐字引文；不改旧 Reader、绑定、模型输入或来源身份。 |
| `lib/conference-reader-recovery-window.js` | A registered, source-authenticated independent Reader window. Old candidates |
| `lib/conference-reader-resolved-origin.js` | Node 内部共享支撑模块 |
| `lib/conference-reader-review-maintenance-evidence.js` | Node 内部共享支撑模块 |
| `lib/conference-reader-review-maintenance.js` | Node 内部共享支撑模块 |
| `lib/conference-reader-signed-draft.js` | Read-only inspection of an actual sealed conference Reader. Representation |
| `lib/conference-recovery-grant.js` | Explicit, immutable additional budgets. A caller's JSON is never the runtime |
| `lib/conference-retained-source-replay.js` | 已完成来源升级进程可能同时保留原抽取与升级抽取。按原分析实际绑定的 |
| `lib/conference-run.js` | 保存会议论文的成员、处理分组与状态变化，并通过哈希核验记录。 |
| `lib/conference-source-context.js` | 从当前进程核验过的会议计划及来源清单指定的本地文件，构建只包含来源资料的分析上下文。 |
| `lib/conference-source-correction-format.js` | Node 内部共享支撑模块 |
| `lib/conference-source-ledger.js` | 只在本机使用的会议论文来源 ledger，内容不可变。它有意与 arXiv 的 |
| `lib/conference-source-resource-correction-apply.js` | The existing adapter owns canonical preparation/sealing and CAS; the source |
| `lib/conference-source-resource-correction.js` | Explicit zero-request source corrections share one transaction and normal |
| `lib/conference-source-upgrade.js` | 来源升级另建进程，保留原有证据和已完成正文，不在原记录上重新绑定。 |
| `lib/conference-staging.js` | 已完成的会议筛选与现有按清单绑定的导入器之间的离线桥接。 |
| `lib/core-summary-format.js` | Node 内部共享支撑模块 |
| `lib/core-summary-semantic-replay-cli.js` | Local publisher replay of the same semantic contract used during analysis. |
| `lib/core-symbolic-source-numerals.js` | A formal construction may contain numbered definitions, equation labels and |
| `lib/cross-stage-consistency.js` | Deterministic Cross-Stage Consistency Gate: |
| `lib/daily-announcement-restart.js` | Node 内部共享支撑模块 |
| `lib/daily-arxiv-announcement-source.js` | RSS is an independent announcement freshness witness, not a replacement for |
| `lib/daily-arxiv-oai-source.js` | Opt-in recovery only. An OAI datestamp is a metadata modification day, never |
| `lib/daily-arxiv-prefix-source.js` | Daily-only recovery for a rate-limited date query. Both routes consume the |
| `lib/daily-fact-review.js` | 只读外部事实反馈；正文始终由正常模型阶段生成，反馈不放入论文临时字段。 |
| `lib/daily-fetch-boundary.js` | Node 内部共享支撑模块 |
| `lib/daily-fetch-format.js` | Node 内部共享支撑模块 |
| `lib/daily-fetch-witness-recovery.js` | This grants only a wider fetch overlap. The lost latest input remains lost; |
| `lib/daily-filter-prefilter.js` | 日更筛选精准预筛与 0 美元正文音频锚点闸门（Wave 11 Track 11C）。 |
| `lib/daily-fresh-source-plan.js` | 默认 API 日更先筛选论文，然后在任何一篇进入深度分析之前，把官方 arXiv |
| `lib/daily-podcast-script.js` | Node 内部共享支撑模块 |
| `lib/daily-reader-legacy-batch-root.js` | Node 内部共享支撑模块 |
| `lib/daily-reader-operator-correction.js` | Explicit local corrections are not model responses or new request allowances. |
| `lib/daily-reader-signed-correction-format.js` | Node 内部共享支撑模块 |
| `lib/daily-reader-signed-correction.js` | Explicit corrections of a completed daily Reader. A retired paid draft stays |
| `lib/daily-reader-signed-fact-patch.js` | Pure range authorization. Scientific/source validation stays in the normal Reader parser. |
| `lib/daily-scoring-refresh-checkpoint-cli.js` | Publication only asks the same recovery helper whether work is pending. |
| `lib/daily-scoring-refresh-checkpoint.js` | A completed scoring refresh is pending Reader work, never a completed paper. |
| `lib/daily-source-format.js` | Node 内部共享支撑模块 |
| `lib/daily-source-skip.js` | 日更入选后，若某篇论文的官方 PDF 在全部候选地址上都返回 404，这篇论文在当前批次 |
| `lib/daily-xml-file-stdin.js` | Private transport for the daily XML validators. A finite regular-file fd |
| `lib/digest-live-status.js` | 只读合成一屏的日更运行状态。 |
| `lib/direct-rewrite-analysis-context.js` | 历史直改的运行器传入的来源对象，要么来自刚抓取的 arXiv generation，要么来自 |
| `lib/empty-daily-batch.js` | 零候选空日只由抓取阶段 `--allow-empty-daily` 显式放行，并由生成清单里的 |
| `lib/env-schema.js` | .env 的集中 schema：供 config:check 与 doctor 共用，避免两边各写一套必填/范围判断。 |
| `lib/error_guidance.py` | 错误指引纯函数库：把运行错误翻译成"下一步该做什么"。 |
| `lib/error-codes.js` | Node 内部共享支撑模块 |
| `lib/error-guidance.js` | 纯函数错误指引库：把运行错误翻译成"下一步该做什么"。 |
| `lib/experiment-source-setting-axes.js` | Categorical-axis recognition only. This never validates metric values, |
| `lib/explicit-reader-retry-round.js` | Node 内部共享支撑模块 |
| `lib/fetch-scheduler.js` | Node 内部共享支撑模块 |
| `lib/filter-decision.js` | Shared decision semantics. Preserve actual saved outputs and retryable fallbacks. |
| `lib/filter-input-contract.js` | Node 内部共享支撑模块 |
| `lib/filter-prompt.js` | Adapters prepare their own source fields; this layer neither normalizes input |
| `lib/filter-scope-evidence.js` | Node 内部共享支撑模块 |
| `lib/fresh-analysis-context.js` | Node 内部共享支撑模块 |
| `lib/fresh-arxiv-rewrite-source.js` | 保存日更和历史重写所需的 arXiv 官方来源。 |
| `lib/fresh-rewrite-publication.js` | 本模块不生成正文、不调用模型，也不改博客。旧的生成字节只是恢复用的备份，不是 |
| `lib/fresh-rewrite-run.js` | Node 内部共享支撑模块 |
| `lib/git-file-bytes.js` | Byte readers only. Catalog/path membership and workflow authority remain with |
| `lib/historical-archive-crawl-authority.js` | 只读重放已保存的归档爬虫身份凭据；不再扫描或签发新的凭据。 |
| `lib/historical-arxiv-batch.js` | 本模块只处理直接 arXiv 来源阶段保存的、按文件名指定的抓取失败交接记录， |
| `lib/historical-arxiv-publication-metadata.js` | 给每份历史 arXiv 来源配的独立发布元数据附件，只和发布有关。 |
| `lib/historical-conference-crawl-authority.js` | 只读重放旧会议爬虫身份凭据，不再扫描或签发。已保存的标题绑定仍须核对原网页， |
| `lib/historical-conference-local-sources.js` | 只收集已保留的会议爬取输入，不碰历史页面。这个模块有意不引入对照表、博客、 |
| `lib/historical-conference-page-projections.js` | 用清单元数据、本地元数据记录里的标题、以及页面 frontmatter 里的标题指纹， |
| `lib/historical-cover-records.js` | 退役成图的只读核验；不创建任务、不取图、不写资产。原数值仅用于重放旧记录。 |
| `lib/historical-daily-primary-arxiv-binding.js` | 解析旧版每日汇总页里那个范围很窄的主论文标记。历史正文只作身份证据：调用方 |
| `lib/historical-direct-aggregate.js` | 根据直接来源重写运行生成每日、会议和会议任务汇总。 |
| `lib/historical-direct-control.js` | 给长时间运行的历史页面直接重写提供只读进度报告，以及显式的暂停/恢复标记。 |
| `lib/historical-direct-page-staging.js` | 使用直接来源运行已保存并核验的来源、分析和论文解读记录生成页面文件。 |
| `lib/historical-direct-publication.js` | 本地历史重写发布时，任何检查失败都停止后续发布步骤，不复用日更的 schema-v3 凭证： |
| `lib/historical-direct-rewrite-input-catalog.js` | 为历史直改构建有明确范围的本地输入目录。输入是一份已批准的会议 PDF 和元数据清单 |
| `lib/historical-direct-rewrite-plan.js` | 按用户批准的规则，为保留的本地输入生成来源处理计划及登记记录。 |
| `lib/historical-direct-rewrite-runner.js` | 历史直接重写方案里负责执行的那一半。规划阶段有意只走到来源指针为止； |
| `lib/historical-direct-tag-supplement.js` | Node 内部共享支撑模块 |
| `lib/historical-icml-alternate-pdf-source.js` | 当规范 OpenReview 接口不可用时，从一份经代码审查的小白名单里取回 ICML |
| `lib/historical-icml-poster-authority.js` | 把保留下来的 ICML miniconf 快照当作身份桥梁来核验： |
| `lib/historical-local-crawl-authority.js` | 只读重放旧本地爬虫凭据及原身份快照。新任务不再通过这里扫描或签发凭据。 |
| `lib/historical-openreview-pdf-source.js` | 把一份通过认证的 ICML OpenReview PDF 保存成本地会议来源清单使用的 |
| `lib/historical-source-identity-supplement.js` | Node 内部共享支撑模块 |
| `lib/historical-source-tag-assignment.js` | 根据来源证据选择的标签独立于正式论文分析、评分和解读文章， |
| `lib/historical-tag-checkpoint-export.js` | Node 内部共享支撑模块 |
| `lib/historical-visual-records.js` | 退役成图的只读核验；不创建任务、不取图、不写资产。原数值仅用于重放旧记录。 |
| `lib/history-conflict-identity.js` | 给冻结身份提示为 conflict 或 multiple 的历史页面提供人工裁定入口。这个模块 |
| `lib/immutable-file.js` | Node 内部共享支撑模块 |
| `lib/keyword-prefilter.js` | 在模型筛选前，根据标题、摘要和类别检查音频相关关键词。 |
| `lib/legacy-history-run.js` | 旧历史记录的来源与运行定位，只读；不包含旧新建、排队或发布写入逻辑。 |
| `lib/legacy-manual-source.js` | 已封存 Manual 全文的只读兼容身份适配器；没有新抓取、新运行或状态写入入口。 |
| `lib/llm-pending-request.js` | 发送前仅保存经过现有隐私白名单过滤的元数据，不证明请求已被服务商接收。 |
| `lib/llm-response-recovery.js` | Only failures in the metadata ledger use this private response archive. It is |
| `lib/llm-usage-format.js` | 只识别账目格式。已保存的事件不改写，调用方继续核验原文件 SHA 和事件身份。 |
| `lib/llm-usage-ledger.js` | Node 内部共享支撑模块 |
| `lib/llm-usage-summary.js` | 只读聚合 LLM 用量事件，供状态面板和费用账本使用。 |
| `lib/llm-usage.js` | 只记元数据。服务商返回的用量与按字符估算的值按设计分开；缓存和推理的小计都不 |
| `lib/merge-failed-reader-bundle.js` | Node 内部共享支撑模块 |
| `lib/model-text-sanitization.js` | Node 内部共享支撑模块 |
| `lib/official-conference-acquisition-v2.js` | 官方会议录获取扩展模块 v2（Wave 13 Track 13.1A）。 |
| `lib/official-conference-acquisition.js` | Node 内部共享支撑模块 |
| `lib/original-file-evidence.js` | Registered original files are data evidence. Never require/evaluate their |
| `lib/page-source-crosswalk.js` | 来源身份对应表。verified 分配必须引用重新核对过的、已认证的来源或身份授权； |
| `lib/page-tag-metadata.js` | Node 内部共享支撑模块 |
| `lib/paid-core-literal-correction.js` | An explicit bounded operator correction of one authentic paid core response. |
| `lib/paid-final-analysis-recovery.js` | Node 内部共享支撑模块 |
| `lib/paper-identity.js` | 跨运行时的论文身份记录，论文可能来自 arXiv 或会议论文集。 |
| `lib/paper-page-staging.js` | 日更发布器的历史路径适配：只接收已经核验的当前分析，不加载旧 crosswalk/标签/调度流程。 |
| `lib/paper-source-authority.js` | 把一张历史页面归到唯一论文身份上，只依据来源文件，且结果可长期复算。加载时 |
| `lib/pdf-layout.js` | 所有只处理 PDF 的路线共用这一套实现。PyMuPDF 通过项目固定的 Python 运行时 |
| `lib/pending-fact-feedback.js` | A pending correction is an obligation, never publishability or request credit. |
| `lib/podcast-github-release.js` | Node 内部共享支撑模块 |
| `lib/post-publication-policy.js` | Node 内部共享支撑模块 |
| `lib/primary-fact-local-repair.js` | Node 内部共享支撑模块 |
| `lib/primary-local-validation-replay.js` | Node 内部共享支撑模块 |
| `lib/prompt-contracts.js` | New requests use stable paths and content hashes. Original path/declaration |
| `lib/prompt-evidence.js` | Current writing reads the checkout. Retired templates are immutable Git |
| `lib/prompt-history.js` | 工作树只保留现行Prompt。历史原字节按已登记Git blob及整文件SHA读取， |
| `lib/prompt-legacy-codec.js` | Only the historical input format is described here. Looking up a path or an |
| `lib/prompt-rendering-contract.js` | Node 内部共享支撑模块 |
| `lib/protocol-codec.js` | 这里只识别格式，不授予来源、分析、费用或发布资格。 |
| `lib/public-network-policy.js` | Node 内部共享支撑模块 |
| `lib/public-resource-probe.js` | Node 内部共享支撑模块 |
| `lib/publication-file-primitives.js` | 共享的不可变文件与博客 Git 基线原语。新历史发布不再装载旧发布流程。 |
| `lib/publication-git-process.js` | Node 内部共享支撑模块 |
| `lib/publish-node-replay-worker.js` | Persistent read-only local replay worker for Python publication gates. |
| `lib/published-blog-receipt.js` | 只核验已保存的正式出版凭证；线上部署和网页仍由发布流程另行核验。 |
| `lib/python-json-packet-bridge.js` | Private transport only: each adapter still owns its packet and output checks. |
| `lib/reader-aggregate-presentation.js` | Display transport only. Callers independently qualify their actual source, |
| `lib/reader-authenticated-pdf-footnote-evidence.js` | A source capability, independent of HTTP reachability and old resource quotes. |
| `lib/reader-authenticated-pdf-table-evidence.js` | Literal PDF tables are a distinct source capability, never a synthesized DOM. |
| `lib/reader-author-parser.js` | Node 内部共享支撑模块 |
| `lib/reader-author-replay-cli.js` | 仅接收调用者继承的私有文件描述符，不读取 env/config，不加载网络或模型模块。 |
| `lib/reader-author-source.js` | Node 内部共享支撑模块 |
| `lib/reader-candidate-format.js` | Encoding equivalence only. The normal recovery reader still authenticates |
| `lib/reader-candidate-normalization.js` | Node 内部共享支撑模块 |
| `lib/reader-candidate-transactions.js` | 这里只记录内存中结果对象与待保存稿件的对应关系；读取来源或复制结果时， |
| `lib/reader-compatible-candidate-replay.js` | Node 内部共享支撑模块 |
| `lib/reader-completed-source-recovery.js` | Private normal recovery of an ordinary completed daily Reader rejected by |
| `lib/reader-concept-term-display.js` | The prose formatter protects inline code with a token ending in "_". Its |
| `lib/reader-content-mode.js` | A mode declaration does not establish source scope, signed parent, permission, |
| `lib/reader-contract.js` | Node 内部共享支撑模块 |
| `lib/reader-derived-parent-replay.js` | Compare authenticated producer outputs. This module creates no parent, stage, |
| `lib/reader-diagnostic-format.js` | Node 内部共享支撑模块 |
| `lib/reader-dom-span-projection.js` | Node 内部共享支撑模块 |
| `lib/reader-dom-span-replay-cli.js` | Publisher replay: local sealed source and actual article only, no model/network. |
| `lib/reader-draft-order.js` | Node 内部共享支撑模块 |
| `lib/reader-fact-pre-request-recovery.js` | Node 内部共享支撑模块 |
| `lib/reader-fact-table-claim-location.js` | Node 内部共享支撑模块 |
| `lib/reader-failed-bundle-resource-replay.js` | Node 内部共享支撑模块 |
| `lib/reader-historical-draft-normalizer-replay.js` | This proves provenance of a paid failed draft; it never grants publishability or attempts. |
| `lib/reader-historical-markdown-closure.js` | Only these exact pure declarations from the original Git blob may execute. |
| `lib/reader-identity-format.js` | Exact metadata decoding only; body/source/ledger checks remain mandatory. |
| `lib/reader-implementation-fingerprint.js` | Single-source Reader parser implementation fingerprint registry. |
| `lib/reader-inline-svg.js` | Node 内部共享支撑模块 |
| `lib/reader-malformed-previous-draft-view.js` | Node 内部共享支撑模块 |
| `lib/reader-next-request-plan.js` | Node 内部共享支撑模块 |
| `lib/reader-operator-patch.js` | Node 内部共享支撑模块 |
| `lib/reader-ordinal-format.js` | Pure encoding selection. No marker or header grants a request, source scope, |
| `lib/reader-paid-resolved-render.js` | Node 内部共享支撑模块 |
| `lib/reader-paid-resolved-replay-worker.js` | 原渲染器只在独立进程内解析旧响应，不继承生产账号，不调用模型。 |
| `lib/reader-paid-response-replay.js` | Node 内部共享支撑模块 |
| `lib/reader-parent-recovery.js` | Node 内部共享支撑模块 |
| `lib/reader-parent-upstream-preflight.js` | Node 内部共享支撑模块 |
| `lib/reader-patch-limits.js` | 人工/受控 Reader 修正每篇最多 8 个已有节点；这不是模型请求或全文额度。 |
| `lib/reader-patch-paths.js` | Single-source authorized JSON-pointer paths for Reader node patches across |
| `lib/reader-pdf-cell-evidence.js` | Node 内部共享支撑模块 |
| `lib/reader-pdf-extraction-scope.js` | Only pure extractor stdout is reused inside one Reader check. |
| `lib/reader-pdf-figure-crop.js` | Node 内部共享支撑模块 |
| `lib/reader-pdf-selection-replay-cli.js` | Publication supplies a full source/PDF grid that it has just authenticated. |
| `lib/reader-pre-image-check.js` | 这里只能证明纯文本或封存 DOM 检查仍失败；不把旧像素记录当成本次像素证明。 |
| `lib/reader-proof-format.js` | Metadata representation only. This scope cannot produce PDF/DOM ownership, |
| `lib/reader-proof-read-scope.js` | Node 内部共享支撑模块 |
| `lib/reader-prose-normalization.js` | Node 内部共享支撑模块 |
| `lib/reader-record-format.js` | Recognize the original wire format without rewriting its bytes. A current |
| `lib/reader-recovery-revision.js` | Node 内部共享支撑模块 |
| `lib/reader-repair-evidence-slice.js` | Node 内部共享支撑模块 |
| `lib/reader-repair.js` | Reader 候选只是恢复用的输入，从来不能当作生产凭证。每个合并进来的 |
| `lib/reader-request-diagnostics.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-binding.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-claims-format.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-claims-replay-cli.js` | Replay the shared analysis contract against source bytes already authenticated |
| `lib/reader-resource-claims.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-input-admission.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-prose.js` | Node 内部共享支撑模块 |
| `lib/reader-resource-sync.js` | Node 内部共享支撑模块 |
| `lib/reader-saved-feedback-input-continuity.js` | Node 内部共享支撑模块 |
| `lib/reader-scientific-quote-coverage.js` | Ephemeral table coverage, never a source capability or a rewritten token |
| `lib/reader-sealed-figure-alias.js` | Only a synchronous physical daily-source read may exempt an unselected DOM |
| `lib/reader-sealed-pdf-column-units.js` | A capability for one complete literal PDF table; it never grants prose units. |
| `lib/reader-sealed-pdf-quote-evidence.js` | Separate PDF quotation origin; it never changes HTML evidence or an input identity. |
| `lib/reader-sealed-pdf-table-evidence.js` | Independent read-only capability. No Reader generation or source-table policy is installed here. |
| `lib/reader-section-format.js` | Node 内部共享支撑模块 |
| `lib/reader-signed-draft-surface.js` | Pure representation operations. No source capability, completion, authorship, |
| `lib/reader-signed-draft.js` | Node 内部共享支撑模块 |
| `lib/reader-signed-operator.js` | Node 内部共享支撑模块 |
| `lib/reader-signed-pruned-table-claim.js` | A display bridge for one authenticated inline table, never a prose allowance. |
| `lib/reader-signed-raw-claim-display.js` | Display projection only. Range/CAS authorization remains in the signed patch |
| `lib/reader-signed-table-targets.js` | Resolve signed table edits in the same ordered inline/placeholder stream as |
| `lib/reader-single-source-table-append.js` | PURE DATA ONLY. The caller must independently hold the real registered grant, |
| `lib/reader-source-blocked-normalization.js` | Node 内部共享支撑模块 |
| `lib/reader-source-diagnostics.js` | 只是修复提示。这些候选既不能授权来源绑定，也不会把渲染后的正文规范化。 |
| `lib/reader-source-display.js` | 仅合并明确TeX注解与完全一致的可见副本；裸重复仍保留并由正式校验阻断。 |
| `lib/reader-source-evidence-binding.js` | Node 内部共享支撑模块 |
| `lib/reader-source-metric-units.js` | Preserve a source's literal distance-based event metric. This does not turn |
| `lib/reader-source-table-column-units.js` | Bare numeric units require source-bound original DOM columns and unique paths. |
| `lib/reader-stage-protocols.js` | Format metadata only. These helpers never replace article, source, paid-input, |
| `lib/reader-table-narrative-labels.js` | Node 内部共享支撑模块 |
| `lib/reader-table-pdf-evidence.js` | The existing projection keeps priority and its bytes. Independent PDF-origin |
| `lib/reader-tables.js` | Node 内部共享支撑模块 |
| `lib/reader-target-ordinal-patch.js` | Node 内部共享支撑模块 |
| `lib/reader-transport-continuation.js` | Node 内部共享支撑模块 |
| `lib/reader-unsent-empty-candidate.js` | Node 内部共享支撑模块 |
| `lib/reanalysis-helpers.js` | 指定论文重分析时，清理 Reader 状态并更新恢复统计。 |
| `lib/repo-rename-path.js` | Node 内部共享支撑模块 |
| `lib/review-overrides.js` | 误报解释记录的结构检查：页级比对页面 SHA，批次条目无页面 SHA。 |
| `lib/saved-fact-feedback.js` | Node 内部共享支撑模块 |
| `lib/saved-scoring-audit-replay.js` | Node 内部共享支撑模块 |
| `lib/scoring-audit-consensus.js` | Node 内部共享支撑模块 |
| `lib/scoring-audit-contract.js` | Node 内部共享支撑模块 |
| `lib/scoring-record-format.js` | Node 内部共享支撑模块 |
| `lib/scoring-rubric-v2.js` | Shared Node.js engine for scoring rubric `type-aware-v2`. |
| `lib/scoring-stability.js` | A proof check only: this does not grant requests, alter attempts or repair a |
| `lib/scoring-third-party-resource-replay.js` | Node 内部共享支撑模块 |
| `lib/selected-full-stage-reanalysis.js` | 仅本次明确选择的论文全阶段重跑；旧账归档不改签，正常恢复不使用本作用域。 |
| `lib/signed-reader-recovery-draft.js` | Node 内部共享支撑模块 |
| `lib/source-acquisition-policy.js` | 抓取前/失败后的“下一步”策略：纯函数，不联网、不写文件，便于测试。 |
| `lib/source-cell-math-display.js` | Node 内部共享支撑模块 |
| `lib/source-classification-failures.js` | Node 内部共享支撑模块 |
| `lib/source-classification-scheduler.js` | Node 内部共享支撑模块 |
| `lib/source-evidence-snippets.js` | Node 内部共享支撑模块 |
| `lib/source-input-format.js` | Node 内部共享支撑模块 |
| `lib/strict-json.js` | 跨协议共用的严格 JSON 读取：拒绝损坏编码与重复字段。 |
| `lib/table-extrema-verifier.js` | Node 内部共享支撑模块 |
| `lib/tag-catalog-change.js` | 比较新旧词表，判断已有分类记录能否继续沿用。判断依据是词表内容， |
| `lib/tag-catalog.js` | Node 内部共享支撑模块 |
| `lib/tag-record-update.js` | 只更新或核验标签阶段记录，不重新生成 Reader、评分或图片，也不调用模型。 |
| `lib/tag-rules.js` | Node 内部共享支撑模块 |
| `lib/tag-stage-record.js` | Node 内部共享支撑模块 |
| `lib/workflow-error-policy.js` | Shared classification only; workflow receipts, queues and retry budgets stay with their owners. |
| `lib/workflow-implementation-files-cli.js` | Read-only bridge for callers that need the same implementation closure the |
| `lib/workflow-implementation-files.js` | Build a conservative local dependency closure without executing any module. |
| `lib/workflow-legacy-codec.js` | Historical declarations only. These hashes never grant source, state, |
| `lib/workflow-record-format.js` | Format recognition only. Callers still validate the original record fields, |
