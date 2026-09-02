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

LLM 决定逐篇写入 `filter-decisions.json`。Muse 实际 batch 为 1，但失败只影响该篇。只有决定完整覆盖 raw 且 filtered 精确对应相关决定时，筛选完成。

## 4. 全文与多阶段分析

优先健康 arXiv HTML，结构不足时回退 PDF。来源状态记录原始长度、实际输入长度、SHA、截断与警告；摘要 fallback 默认不可发布。

分析阶段按指纹恢复：

1. 主分析；
2. 开源与 Demo 扫描；
3. 事实审校；
4. 表格、方法和结构修复；
5. 类型感知评分审计；
6. API Reader v3，并重放表格/公式、作者机构和开源资源来源身份；
7. 官方 Figure 计划与正文物化。

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

- generate：从 canonical 重新解析评分与正文，安装页面并签发 schema v3 generation manifest。
- review：汇总页先审，论文页并发；每页以不可变 SHA artifact 执行确定性、LLM、图片与 Hugo gate。
- push：只提交 receipt 允许的精确 delta，推送后验证远端 `main` OID。

review worker 不修改已审页面。任何修正都返回生成/修复阶段；页面 SHA、Git 基线、协议或 remote 漂移会阻断。

汇总页使用 `reader-facing-v3` 布局：排行榜、中文标题和英文标题都链接到对应独立博客；标签与八维评分只显示一次，随后依次显示排名分档、文档类型、arXiv 原文链接和作者机构。旧版重复的“分数/置信度/标签/arXiv”尾行禁止重新生成。汇总页与单篇页中的读者可见裸 HTTPS URL 会转成 Markdown autolink；已有链接、图片、代码块和 frontmatter 保持不变。

## 7. 发布后视觉

远端 OID 验证后，系统规划最终评分 TOP 10 论文长图和一张汇总封面。脚本不调用图像 API；Codex 使用内置 `image_gen`。

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

`visual:prepare` 将校验后的 `.bin` 缓存物化为真实扩展名路径。生成后必须目检并用任务 token 登记。用户明确“不生图”时签发视觉 waiver，不能伪造 complete。

## 8. 恢复与验收

```bash
# 从失败阶段继续
./run-daily-digest.sh YYYY-MM-DD --from review

# 只续分析
npm run deep -- --date YYYY-MM-DD

# 刷新 Reader/评分
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# 数据与整批状态
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

最终报告必须在最后一次 push/record 之后重新生成。它是当时快照，不会随状态变化自动更新。
