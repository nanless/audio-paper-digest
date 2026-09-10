# 默认 LLM/API 工作流

## 适合谁与完成目标

给需要运行、理解或恢复某日论文速递的人。最短入口：

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` 是同义命令。完成不是“分析文件生成”，而是数据闭环、博客远端发布和视觉门禁全部通过。Manual 仅在用户显式要求时进入 [manual/README.md](../manual/README.md)。

## 流程总览

```text
日期与归档
 → 代理抓取
 → 博客去重
 → 关键词预筛
 → LLM 筛选
 → 封存本次官方 arXiv TXT/PDF
 → 全文与多阶段分析
 → 评分审计
 → API Reader 长文
 → 博客 generate/review/push
 → 远端 OID
 → 视觉生成与登记
 → digest:status
```

## 1. 日期与归档

从 fetch 开始时，目标日期必须是北京时间当天。`autoArchiveCurrentData()` 将上一批次的 raw、decisions、filtered、deep 等按日迁入 `data/archive/<date>/`；`papers.json` 永不移走。

历史批次不得重新走“今天的抓取”冒充原批次，只能从已有安全阶段续跑：

```bash
./run-daily-digest.sh YYYY-MM-DD --from generate
```

实际允许阶段以脚本 usage 为准。

## 2. 抓取

arXiv 和 HuggingFace 都走项目代理。每个来源产生独立 checkpoint，绑定候选数、稳定内容 SHA 和健康状态。某个来源损坏只重抓该来源；完整性失败时不能继续写 complete 筛选集。

抓取后先按 normalized arXiv ID 合并，再排除博客已发布论文。完整输入写入 `raw-candidates.json`。

## 3. 关键词预筛与 LLM 筛选

关键词层追求召回率，不代替语义裁决：

- eess.AS、cs.SD 核心类别始终进入 LLM。
- 摘要不足 80 字符的证据不足项进入 LLM。
- 命中语音、音乐、音频、声学、多模态语音及常见模型/数据集词族的论文进入 LLM。
- 只有摘要完整且明显未命中的补充类别论文可形成确定性否定。

LLM 决定逐篇写入 `filter-decisions.json`。Muse 使用配置的筛选 batch；当前 sticky 账号只有在明确额度耗尽时，才在同一次逻辑请求中改用下一账号，普通 429 仍按短期限流处理。只有决定完整覆盖 raw 且 filtered 精确对应相关决定时，筛选完成。

## 4. 全文与多阶段分析

筛选完成后、深度分析前，必须为每个入选 arXiv ID 新拉取官方 HTML 文本与 PDF，并原子封存
`data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/` 下的 `source.txt`、
`source.pdf`、`source-runtime.json` 与 `source-manifest.json`。随后分析、Reader、generate、review 和 push
只重放该 sealed generation；不能使用旧 `data/current` 文本、PDF 或图片缓存。HTML 优先、PDF 回退只发生在这次
source capture 内。图像仅在当前模型调用的 OS 临时目录物化，不能写入 runtime 图片缓存。来源状态记录原始长度、
实际输入长度、SHA、截断与警告；摘要 fallback 默认不可发布。

分析阶段按指纹恢复：

1. 主分析；
2. 开源与 Demo 扫描；
3. 事实审校；
4. 表格、方法和结构修复；
5. taxonomy 封口与核心摘要封口；
6. 类型感知评分审计；
7. API Reader v3，并重放表格/公式、作者机构和开源资源来源身份；
8. 官方 Figure 计划与正文物化。

主分析 canonical 的固定标题服务解析；API Reader 负责读者可见长文。它必须解释术语组合、训练/求解、数据集、指标、结果、负面证据、复现与边界，并让表格和图片紧邻支撑它们的论证。

每篇完成立即在论文锁内合并回 `deep-analysis-result.json` 并同步 `papers.json.digestStatus`。中断不会丢失已完成论文。

## 5. 评分与 production proof

评分审计引用证据账本，先判文档类型，再按八维评分。代码重算总分、应用证据上限并保存 audit/input/output SHA。Reader、作者机构、Figure 和评分绑定全部闭合后，默认批次才具备 `llm_api_production` proof。

任何 Manual-only lineage 混入默认 API 都必须失败关闭。

## 6. 博客三阶段

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

- generate：从 canonical 重新解析评分与正文；对 Reader v3/Manual v6 页面生成
  `researcher-workbench-v1` front matter 以及 citation JSON/BibTeX/RIS、
  rethink-context JSON 同源 sidecar，再把页面和 sidecar 作为一个 SHA 绑定事务安装并
  签发 schema v3 generation manifest。arXiv 版本只接受输入 ID 中显式出现的 `vN`，
  base ID 不推断 v1。
- review：汇总页先审，论文页并发；每页以不可变 SHA artifact 执行确定性、LLM 与图片审查。已通过的“相对路径 + 页面内容 SHA”永久复用，只有页面内容 SHA 变化才重审该文件；Hugo gate 仍作为当前批次运行。
- push：只提交 receipt 允许的精确 delta，推送后验证远端 `main` OID。

review worker 不修改已审页面。任何修正都返回生成/修复阶段。发布器代码变化仍会让 generate 重新渲染并产生新 manifest；随后 generation manifest 元数据、模型、发布器代码、review 协议指纹或 Hugo 运行时变化都不失效最终字节未变的逐页通过证据；它们只要求重跑批次 gate 并重签 receipt。Git 基线或 remote 漂移仍会阻断 push。

generation 记录实际选中的 current、日期 archive 或 `--data-file` 的绝对路径、字节数和 SHA-256；review/push
只能重放这一 generation input reference，不能改读随后变化的 current 文件。

汇总页使用 `reader-facing-v3` 布局：排行榜、中文标题和英文标题都链接到对应独立博客；标签与八维评分只显示一次，随后依次显示排名分档、文档类型、arXiv 原文链接和作者机构。旧版重复的“分数/置信度/标签/arXiv”尾行禁止重新生成。汇总页与单篇页中的读者可见裸 HTTPS URL 会转成 Markdown autolink；已有链接、图片、代码块和 frontmatter 保持不变。

## 7. 发布后视觉

远端 OID 验证后，系统规划最终评分 TOP 10 论文长图和一张汇总封面。脚本不调用图像 API；Codex 使用内置 `image_gen`。

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

Reader 页面在 `ephemeral-no-persisted-figure-assets-v1` 下直接保留已签 arXiv 官方 HTTPS 图片 URL，不在博客仓库复制图片字节。`visual:prepare` 只为 legacy manifest 将校验后的 `.bin` 缓存物化为真实扩展名路径；modern 日更复验已签 Figure 的 URL、ordinal、DOM/像素 SHA 与 MIME 后输出空 `referencedImagePaths`，生图仅依据已签 Reader 文本，不回退已销毁缓存。生成后必须目检并用任务 token 登记。用户明确“不生图”时签发视觉 waiver，不能伪造 complete。

## 8. 恢复与验收

```bash
# 从失败阶段继续
./run-daily-digest.sh YYYY-MM-DD --from review

# 只续分析
npm run deep -- --date YYYY-MM-DD

# 只续 canonical 中未完成论文
npm run batch

# 只退役当前未完成论文的失败 Reader 候选后续跑
npm run batch -- --retry-failed-readers

# 强制重分析
npm run reanalyze -- --concurrency 5

# 刷新 Reader/评分
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# 数据与整批状态
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

最终报告必须在最后一次 push/record 之后重新生成。它是当时快照，不会随状态变化自动更新。

`deep`、`batch`、`reanalyze` 和 `api:reader:refresh` 只能重放 current canonical 的 `dailyFreshSourceRun`。它精确绑定本批日期、论文集合和每篇 sealed PDF/TXT/runtime/manifest；命令不会补抓来源或读取 legacy cache。缺少或漂移时先重新运行 `digest:prepare`，图像也只能在当前调用的 OS 临时目录物化。`batch --retry-failed-readers` 只退役当前未完成论文的失败 Reader 候选；`reanalyze` 会退役全部旧失败候选并清空 Reader/图片补充状态后再强制全量分析。
