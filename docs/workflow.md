# 默认 LLM/API 工作流

## 适合谁与完成目标

本文说明如何运行或恢复某日论文速递。首次运行先按[安装与配置](setup.md)准备环境，确认当前工作区角色为 `daily`，再执行：

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` 是等价命令。完整任务包括候选与分析数据、博客发布、上线核验，以及发布后的论文长图和封面；生成了分析文件或脚本成功退出，都不足以宣告完成。只有用户明确选择人工流程时，才进入 [Manual 子系统](../manual/README.md)。模型、网络或额度失败不会自动切换到人工流程。

## 流程总览

```text
检查日期并归档 → 代理抓取 → 排除已发布论文 → 关键词预筛 → 模型筛选
             → 保存官方文本与 PDF → 全文分析与评分 → 生成解读正文
             → 生成博客 → 审查 → 推送并核对远端提交
             → 配图生成与登记 → 上线与最终状态核验
```

## 1. 日期与归档

从抓取开始运行时，目标日期必须是北京时间当天。`autoArchiveCurrentData()` 将上一批次的候选、筛选决定、入选结果和分析结果按日期移入 `data/archive/<date>/`；跨运行去重库 `papers.json` 始终留在当前目录。

历史日批次只能从已有数据所支持的安全阶段继续，不能重新抓取今天的论文冒充当时的结果。例如：

```bash
./run-daily-digest.sh YYYY-MM-DD --from generate
```

默认 API 流程可从 `generate`、`review`、`push` 或 `visual` 恢复；人工流程的 `tasks`、`spec`、`analyze` 不适用于默认 API。实际允许的阶段以脚本参数检查为准。

## 2. 抓取

日更先更新博客远端，再从已推送的最后日更确定固定 UTC 补抓窗口。arXiv 每页 100 条，逐页读取并核对数量，不以已知论文或总量 100 停止；查询过大时按分钟继续拆分。HuggingFace 逐日覆盖同一窗口。协议 v7 的同日续跑只有重新核对已发布基线、来源配置和完整检查点后，才能沿用原 `until`；旧 v6 不能证明多日补抓完整。详见 [日更补抓边界](daily-fetch-boundary.md)。

arXiv 和 HuggingFace 请求使用项目代理。每个来源分别记录获取状态、候选数量和内容 SHA；某来源的结果损坏时，只重新获取该来源。七类 arXiv 和 HuggingFace 的必需来源全部通过获取状态与固定窗口覆盖检查后，才允许付费模型筛选；筛选续跑也先重新检查来源。任一来源尚不完整时，保留已保存的检查点和部分候选并停止，不调用筛选或分析模型。

程序按规范化 arXiv ID 合并候选，排除博客已发布论文，然后将已获取的候选保存到 `raw-candidates.json`。部分来源的候选可供检查和补抓，但不能称作完整筛选输入。

## 3. 关键词预筛与 LLM 筛选

关键词预筛尽量保留可能相关的论文，最终是否入选由模型结合论文内容判断：

- 关键词预筛的核心音频类别只有 `eess.AS` 和 `cs.SD`（`scripts/lib/keyword-prefilter.js` 的 `CORE_AUDIO_CATEGORIES`），这两类论文始终进入模型筛选。抓取侧 `scripts/config.js` 另有 `priority: 'core'`，还包含 `eess.SP`；那只决定抓取顺序和跨类别去重，不豁免关键词预筛。
- 摘要少于 80 字符时，不能仅凭关键词排除。
- 命中语音、音乐、音频、声学、多模态语音及常见模型或数据集词族的论文进入模型筛选。
- 只有摘要完整且明显未命中的补充类别论文，才由关键词规则直接判为不相关。

模型决定逐篇写入 `filter-decisions.json`，筛选批次大小由 `PD_FILTER_BATCH_SIZE` 控制。当前账号只在明确返回 `GoUsageLimitError` 或 `Insufficient balance` 时切换到后续账号；普通 429 仍按限流规则退避。决定必须覆盖全部候选，`filtered-papers.json` 必须精确对应相关决定并扣除显式排除项，筛选才算完成。

### 指定论文重新筛选

人工核对摘要与模型理由后，如需让模型重新判断某篇论文，先结束正在运行的日更，再运行：

```bash
npm run fetch -- --date YYYY-MM-DD --refilter ARXIV_ID --refilter-reason '摘要与原筛选理由存在具体冲突'
```

日期必须是北京时间当天，ID 必须对应本批完整来源中的有效模型决定；关键词直接排除项不能通过这个入口复筛。复核原因用于保存操作记录，模型仍使用原提示词判断，不能用此参数指定入选结论。程序保存原决定的完整文件，再移除目标旧决定；其他有效决定复用，尚缺决定继续筛选。新请求失败时，目标旧决定不会重新当作本次成功结果。每批保存筛选进度后同步保存复核记录；记录保存失败会停止运行。

本批已进入封存来源分析时，程序拒绝改变入选集合。复筛完成后，这个入口继续正常的来源封存与分析；分析合格后从博客生成阶段继续审查、推送、部署与网页核验及视觉任务，不能把复筛完成当作日更完成。

## 4. 全文与多阶段分析

筛选完成后，程序为每个入选 arXiv ID 重新获取官方 HTML 文本和 PDF，原子保存到 `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`。每篇必须有 `source.txt`、`source.pdf`、`source-runtime.json` 和 `source-manifest.json`。

HTML 优先、PDF 回退发生在这次来源获取中。后续分析、解读生成和博客三阶段只使用并校验这组来源，不能退回旧 `data/current` 文本、PDF 或图片缓存。来源记录包含原文与实际输入长度、SHA、截断情况和警告；摘要分析默认不能发布。论文图片仅在当前模型请求的系统临时目录中准备和使用，不保存到运行目录的图片缓存。

每篇按以下阶段分析，并根据输入、模型、协议、提示词、温度、预算和输出指纹确定恢复位置：

1. 主分析。
2. 查找代码、开放资源和 Demo 证据。
3. 核查并修订事实。
4. 修复表格、方法细节和结构问题。
5. 校验并保存标签与核心摘要。
6. 确定文档类型，再按八维核查评分。
7. 生成 API Reader v3 解读正文，校验表格、公式、作者机构和资源的原文来源。
8. 准备官方论文图，并检查它们在正文中的位置与说明。

正式分析结果的 13 个固定标题供程序解析。面向读者的正文由 API Reader 根据原文证据和实际传入的论文图生成，解释术语组合、训练或求解过程、数据集、指标、结果、负面证据、复现方法与适用边界。表格和图片应紧邻它们支撑的论证。

每篇完成后，程序在论文锁内重新读取最新结果，合并到 `deep-analysis-result.json`，同步 `papers.json.digestStatus`。已保存的成功结果可在中断后继续使用；同一论文最新尝试失败时，仍须重试，不能只因保留旧成功正文就算完成。

## 5. 评分与发布资格

评分检查引用论文证据，先判定文档类型，再评价八个维度。代码重算总分、应用证据支持的分数上限，并记录审计、输入和输出 SHA。

只有正文、作者机构、论文图、评分、来源身份和完整论文集合的校验全部通过，默认批次才能取得 `llm_api_production` 发布记录。默认 API 批次不能混入仅供人工流程使用的分析来源或证明。

## 6. 博客三阶段

严格按顺序执行：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

`generate` 从正式分析结果重新解析评分和正文。Reader v3 或 Manual v6 页面还会生成 `researcher-workbench-v1` 页面元数据，以及 Citation JSON、BibTeX、RIS 和 `rethink-context.json` 四种同站点文件。页面与附属文件一起安装，保存内容 SHA 和 schema v3 生成清单。

引用和页面使用实际经过验证的 arXiv 来源版本。普通 ID 没有版本号时，不猜成 `v1`；当前 PDF 返回 404、使用同一论文的官方历史版本时，依据已保存的 `sourceVersion.selectedSourceId` 展示实际版本，并保留当前稿不可用的提示。

`review` 先审汇总页，再并发审论文页，执行程序检查、模型审查、图片检查及 Hugo 构建。审查不修改页面；内容需要修正时，回到生成或分析阶段。每页的通过记录按“相对路径 + 页面内容 SHA”保存，只有该文件内容变化才重新审查。Hugo 和当前批次的其他检查仍须运行。

发布器代码变化会使 `generate` 重新渲染，以发现实际内容变化。生成清单元数据、模型、代码、审查协议或 Hugo 运行时变化时，需要重新执行批次检查并生成当前审查记录，但不能因此重审最终内容未变的文件。Git 基线或远端身份变化仍会阻止推送。

`push` 只提交审查记录允许的精确文件变更，推送后核对远端 `main` 提交。生成阶段已记录实际使用的当前文件、日期归档或 `--data-file` 的绝对路径、大小和 SHA-256；审查和推送必须核对同一输入，不能改读后来变化的当前文件。

汇总页使用 `reader-facing-v3` 布局，排行榜、中英文标题都链接到独立博客。标签和八维评分只显示一次，其后是排名分档、文档类型、arXiv 原文链接和作者机构；不能重新生成旧版重复的分数、置信度、标签和 arXiv 尾行。读者可见的裸 HTTPS 地址会转成可点击的 Markdown 自动链接，已有链接、图片、代码块和页面元数据保持原样。

远端提交核验只说明博客提交已经到达远端。宣告上线前，还须确认对应提交的 GitHub Pages 构建和部署均成功；若部署的是后续提交，要验证它仍保留本批已审页面内容。逐页检查目标日期汇总页及全部已发布论文页的 HTTP 200、正式地址和标题，保留核验记录。部署失败时，读取失败日志、修复并继续检查。当前 `digest:status` 不会自动完成这些核验。

## 7. 发布后视觉

远端提交验证后，系统规划最终评分前 10 篇论文的长图和一张汇总封面。项目脚本只管理任务，不调用图像 API；实际生成须使用 Codex 内置 `image_gen`。分工：`visual:post-publish` 在远端验证后创建或恢复两类图片任务（任务缺失或失效时重跑它）；`visual:prepare` 在每次生图前输出本次可用的绝对参考路径。

```bash
npm run visual:post-publish -- --date YYYY-MM-DD
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

采用 `ephemeral-no-persisted-figure-assets-v1` 的页面保留已校验的 arXiv 官方 HTTPS 图片地址，不向博客仓库复制图片。新日更的 `visual:prepare` 核对官方图片地址、顺序、DOM 与像素 SHA、MIME 后，返回空的 `referencedImagePaths`；长图根据已验证的解读正文生成，不回退旧图片缓存。旧视觉清单的兼容流程会核对 `.bin` 缓存并提供实际扩展名的路径；无论哪种情况，都只使用本次准备命令输出的绝对参考路径。

每张生成图都须目检标题、中文、箭头、指标方向、数字和排行榜，再用当前任务 token 及 `--qa-attested true` 登记。用户明确取消配图时，使用 `digest:waive-visuals` 保存与当前发布绑定的取消记录，不能把待生成任务伪称完成。

## 8. 恢复与验收

以下命令处理不同范围的恢复，先确认失败阶段，再选择入口：

```bash
# 从博客审查阶段继续
./run-daily-digest.sh YYYY-MM-DD --from review

# 继续未完成的分析
npm run deep -- --date YYYY-MM-DD
npm run batch

# 停止复用未完成论文的旧失败解读候选，再续跑
npm run batch -- --retry-failed-readers

# 清空旧解读与图片补充状态，强制重分析
npm run reanalyze -- --concurrency 5

# 刷新解读正文和评分
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# 检查数据与整批状态
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

`deep`、`batch`、`reanalyze` 和 `api:reader:refresh` 只能使用当前正式分析结果中 `dailyFreshSourceRun` 指向的来源。批次日期、完整论文集合，以及每篇 PDF、文本、来源信息和清单必须全部匹配。命令不补抓来源、不读取旧缓存；来源缺失或发生变化时，会在模型或图片请求前停止。目标仍为北京时间当天时，可重新运行同日 `digest:prepare` 获取并保存来源；历史日期须保留失败记录，按历史维护流程处理，不能从抓取阶段重跑。

`batch --retry-failed-readers` 只使当前未完成论文的失败候选不再被复用；`reanalyze` 会处理全部旧失败候选，并清空解读及图片补充状态，再强制重分析。两者都须满足相同来源要求。

最后一次推送、图片登记或取消配图后，重新生成最终报告。报告只反映读取时的状态，不会自动更新。只有数据、审查、远端发布和上线核验全部完成，且配图已完成或有仍适用于当前发布的用户配图取消记录时，才能宣告整批完成。
