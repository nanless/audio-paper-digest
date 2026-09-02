# Paper Digest - 语音/音乐/音频论文速递全流程自动化

**[English](README.en.md)** | 中文

本项目用于生成“语音/音乐/音频论文速递”。默认日更采用 LLM/API 自动路线：联网抓取后执行关键词预筛、模型逐篇筛选、多阶段全文分析、证据约束评分、面向初学研究者的连续长文、博客 review/push 与发布后视觉。Production Manual v6 保留为用户显式选择的人工高保障路线。Node 端配置集中在 `scripts/config.js`，Python 发布路径集中在 `scripts/path_config.py`。

## 最短上手路径

```bash
npm install
cp env.example .env          # 填写 PAPER_ANALYZER_API_KEY / MODEL / ENDPOINT 与代理
npm test                     # 默认 API、共享层和显式 Manual 测试
npm run digest:prepare -- "$(TZ=Asia/Shanghai date +%F)"
npm run digest:status -- --date "$(TZ=Asia/Shanghai date +%F)"
```

完整日更会发布博客并准备视觉任务；脚本退出后仍要完成或显式豁免视觉资产。
安装细节见 [环境配置](docs/setup.md)，阶段恢复见 [主流程](docs/workflow.md)，按问题找文档可从
[文档导航](docs/README.md) 开始。

显式 Manual/人工高保障路线已集中到 [`manual/`](manual/README.md)。它使用逐篇隔离的 Terra-high 任务、完整 ArtifactIndex、records v4/spec v6 与独立页面审查；不会由 API、网络或配额错误自动触发。运行或维护 Manual 前，请从该目录入口按需读取工作流、架构、编辑契约和 Prompt。

用户明确取消发布后图片时，运行 `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "用户明确取消视觉资产"` 记录与远端发布 commit 及当前视觉任务 SHA 绑定的可审计豁免；它不会生成图片，也不会把 pending 资产伪装成 complete。

LLM endpoint 必须使用 HTTPS（仅 loopback 本地测试允许 HTTP）。arXiv 元数据抓取的重试、退避、累计等待、绝对截止、响应字节上限与 User-Agent 均由 `ARXIV_CONFIG` 管理，覆写项见 [环境配置](docs/setup.md)。

对 Codex 说“运行/进行某一天的论文速递”，默认含义是运行 `npm run digest:prepare -- YYYY-MM-DD`，即 LLM/API 自动抓取、筛选、全文分析、评分校准、读者长文、博客 review/push、TOP 10 论文长图、汇总封面和最终状态验收。`digest:api` 是同义入口；只有明确说“使用 Manual/人工流程”时才运行 `npm run digest:manual -- YYYY-MM-DD`。博客发布无需再次确认；其他发布渠道不在默认范围。

已有 API 批次需要升级读者长文时，可运行 `npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`。命令只读取 `batchDate` 精确匹配的 current canonical，按单篇锁与提交时身份校验立即持久化成功项；续跑自动跳过 SHA 闭环的当前 v3，只重试未完成论文。

若最终正文规范化后仅有标题、术语桥引用等计划表面字节漂移，可运行 `npm run api:reader:refresh -- --all --date YYYY-MM-DD --surface-bindings-only --concurrency 5`。该模式不抓取、不调用 LLM，只从最终正文确定性重绑计划并更新 SHA。

深度分析采用 `type-aware-v1` 类型感知评分：先将文档归类为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究或应用研究，再按对应证据标准评审。八维权重、满分 11 和总分封顶 10 保持统一；分项与总分最多一位小数，开源分使用固定锚点。文档类型不提供固定加分，同一个缺陷只能在一个主要维度扣分；理论工作的完整证明材料可作为核心公开产物，不会因没有代码/模型/数据而被机械归零。

视觉摘要位于发布流程之后：先完成全部论文深度分析，再生成、review 并 push 全部博客（汇总页和所有论文页）。`push-blog.py` 验证远端 `main` OID 后自动建立可恢复视觉任务，只为最终评分 TOP 10 的论文各生成一张纵向 PNG 长图；同分按规范化 arXiv ID 稳定排序。长图顶部逐字显示英文论文标题，正文用约 220–360 个简体中文字符完整串联研究问题、方法、实验、结论与局限。若深度分析已筛选并缓存可靠的论文方法总览图、架构图或关键结果图，任务会绑定最多两张参考图及其 SHA。最终图片由内置生图直接完成标题、中文说明、结构图、实验数据和纸张拼贴艺术的一体化构图，不再经过旧的确定性文字卡片合成器；登记前必须逐项目检标题、文字、箭头关系、指标方向和数值，存在不可读或实质错误时重新生成。论文长图和汇总封面统一采用暖白底、低饱和配色和充足留白的清新纸张编辑风，通过细微纸纹、纸片叠层、局部毛边、少量胶带和柔和投影建立设计层次；明确禁止脏旧复古、拥挤手账、深色霓虹、赛博 HUD 和仪表盘式排版。

发布后还生成一张批次汇总图，标题、热门方向和 TOP 10 排行榜均从已发布批次对应的审计数据确定性计算。论文长图与汇总图独立绑定数据、prompt、任务 token 和资产 SHA；重跑只补失败、缺失、损坏或指纹失效项。同一天全部生成图片扁平归档到 `data/archive/<日期>/visual-summaries/`：封面为 `00-digest-cover-<日期>.png`，论文长图为 `<两位排名>-<paper-id>-<title-slug>.png`，严格按最终 rank 而非生成完成顺序编号；图片不滞留在 current。它们不进入已经发布的博客清单，也不构成博客 generate/review/push 的前置门禁。

LLM 筛选前默认执行高召回关键词预筛，核心音频类别提供兜底，明显无关论文不会消耗 LLM 配额。`npm run keyword:recall` 同时校验人工正负金标与历史有效正样本；已确认的历史 LLM 误筛必须显式记录理由，不计入有效正样本分母。日更结束后运行 `npm run digest:status -- --date YYYY-MM-DD`，统一验收抓取、筛选、分析、博客远端发布和两类视觉资产，并保存机器可读报告。报告只反映命令执行时刻；后续 push 或视觉 `record` 后必须重跑，不能把旧报告当作实时状态。历史日期在 current 滚动后读取同日 archive，但只有 raw/decisions/filtered/deep 的批次、逐篇决定覆盖和论文集合全部一致才会报告完整；当前日期不会回退 archive。

深度分析采用分阶段证据预算控制 token：主分析仍覆盖全文，超长论文按全文位置和任务关键词均衡取样；开源扫描、审校重写、评分审计、方法/表格和结构修复只接收各自相关的证据切片。新分析和重分析必须通过版本化硬契约：`evidence-rich-v2` 在 `bounded-v1` 的最多 2 张表、每表 12 个数据行、8 个指标列与列数一致性上，进一步要求设置/数据集/基线字段、至少 3 行证据和 2 个数字、指标方向、表前比较问题、表后关键差异与证据边界，并在全文提供时覆盖消融或负面结果；`detailed-v1` 要求方法章节至少 600 个中文字符、三个有效段落和明确结构描述。历史 `bounded-v1` 与无标记成功记录保持原语义兼容。博客 review 独立论文页并发度限制为 1–5；微信、飞书和小红书在默认数据源下必须绑定同日博客 generation manifest 与远端验证 receipt 的 `publishedPapers` 权威快照，清单缺失也会失败；明确独立运行须传 `--ignore-blog-snapshot`。视觉登记必须在逐项核对 `qaClaims` 后显式传 `--qa-attested true`，声明随资产写入 manifest 且缺失或损坏时完成态失效。

显式 API/LLM 路线会在评分阶段生成结构化 `evidenceProfile`，再由代码按消融、评测范围、样本规模与部署测量应用可解释上限，降低“文字写得像高分但证据没有跟上”的偏差。事实与评分闭环后，独立的 `beginner-researcher-v3` 长文阶段生成 12–18 节、5000–18000 中文字的初学研究者教程；它要求 4–10 组术语组合解释、按原文证据动态要求 2–4 张表格且至少 2 张为 5 列以上宽表。可安全下载的官方 Figure 会作为多模态像素输入交给 Muse，正文逐图固定“导读—看图路径—原图—图注—解释”闭环。新生成禁止降级到 v2，v1/v2 只作历史读取兼容；旧 13 节 canonical 继续承担机器解析兼容。

---

标准日更会在任何 Git 变更前检查 generation schema v3 与 `publishedPapers` 视觉能力；schema v1/v2 仅用于显式历史维护，review receipt 标记视觉 N/A。相同非空 generation 可整链幂等重跑，但复用发布凭证前会重新校验当前 review 协议、文件与提交，并实时确认当前 remote 身份和远端 `main` OID；网络失败、远端分支漂移或 `origin` 换仓都会拒绝复用。渠道发布按目标博客发布日期绑定远端已验证的 `publishedPapers`，保留论文原始抓取批次；current 已滚动时回退日期归档，自定义输入也只有显式 `--ignore-blog-snapshot` 才能绕过快照。

## 文档说明

更适合按任务查阅的入口见 [`docs/README.md`](docs/README.md)。

| 文件 | 用途 | 读者 |
|------|------|------|
| [README.md](README.md) | 项目概览、快速开始、命令速查 | 人类用户 |
| [AGENTS.md](AGENTS.md) | Agent 不看代码容易遗漏的紧凑规则 | AI Agent |
| [SKILL.md](SKILL.md) | Agent 的完整执行规则与安全约束 | AI Agent |
| [`docs/README.md`](docs/README.md) | 按任务阅读的文档索引与默认 API 代码地图 | 所有人 |
| [`scripts/README.md`](scripts/README.md) | 默认 API 与共享脚本的入口/依赖/状态地图 | 开发者与 Agent |
| `docs/workflow.md` | 主流程详解（归档、抓取、筛选、分析、保存） | 使用者 |
| [`manual/README.md`](manual/README.md) | 显式 Manual 路线的入口、命令、工作流和契约导航 | Manual 使用者与维护者 |
| `docs/scripts.md` | 全部脚本功能说明 | 开发者 |
| `docs/data-format.md` | 数据文件格式与字段说明 | 开发者 |
| `docs/setup.md` | 安装初始化、环境变量、日志、代理配置 | 新用户 |
| `docs/troubleshooting.md` | 常见问题排查与修复 | 使用者 |
| `docs/maintenance.md` | 维护约定、评分标准、标签口径 | 维护者 |
| [`prompts/filter.md`](prompts/filter.md) | 筛选阶段 LLM prompt | 维护者 |
| [`prompts/deep-analysis.md`](prompts/deep-analysis.md) | 深度分析主 prompt（Round 1，纯文本） | 维护者 |
| [`prompts/api-reader-article.md`](prompts/api-reader-article.md) | API Reader v3 初学研究者长文 prompt | 维护者 |
| [`prompts/image-supplement.md`](prompts/image-supplement.md) | 图像筛选与插图计划 prompt（双模型模式；最多 4 张并使用稳定段落 ID） | 维护者 |
| `prompts/visual-summary.md` | 发布后 TOP 10 论文纵向长图 prompt | 维护者 |
| `prompts/digest-cover.md` | 发布后汇总图 prompt（标题 + 热门方向 + TOP 10 排行榜） | 维护者 |
| `prompts/opensource-scan.md` | 开源链接扫描 prompt（Round 2） | 维护者 |
| `prompts/gap-fill.md` | 审校重写 prompt（Round 3） | 维护者 |
| `prompts/structure-repair.md` | 缺失必要章节时的主模型局部结构修复 prompt | 维护者 |
| `prompts/scoring-audit.md` | 主模型最终类型感知评分审计（送审前移除旧评分理由，仅依据正文与证据账本重建评分字段与理由） | 维护者 |
| `prompts/api-reader-article.md` | API 路线初学研究者长文（动态问题标题、学习依赖顺序、事实与文风硬门禁） | 维护者 |

> **铁律**：真实行为以 `scripts/*.js` / `scripts/*.py` 当前实现为最终准绳。若文档与代码冲突，以代码为准并修正文档。

---

## 项目结构

```
audio-paper-digest/
├── scripts/              # 默认 API 与共享脚本
├── tests/                # 默认 API 与共享测试
├── manual/               # 显式 Manual 的文档、Prompt、脚本和测试
├── data/                 # 工作数据与归档（gitignored）
│   ├── current/          # 当前工作数据
│   └── archive/          # 按日期自动归档
├── logs/                 # 默认文件日志（gitignored；可在 .env 中用 PD_DISABLE_FILE_LOGS=1 关闭）
├── prompts/              # LLM prompt 文件
├── docs/                 # 详细文档
├── package.json          # npm scripts
├── run-daily-digest.sh   # Codex 默认日更编排入口（脚本阶段完成后接续内置生图）
├── run-full-fetch.sh     # 仅数据流程入口（抓取、筛选、深度分析）
└── README.md / SKILL.md
```

详见 [`docs/scripts.md`](docs/scripts.md) 了解每个脚本的功能，[`docs/data-format.md`](docs/data-format.md) 了解数据文件格式。

---

## 快速开始

```bash
# 1. 安装依赖
npm install
pip3 install -r requirements.txt
# Node 版本要求：>=20.18.1 <21 或 >=22.3.0；Python 依赖包含 Pillow

# 2. 配置 API Key（写入 `.env`）
#    主模型（文本分析，必填）
#    PAPER_ANALYZER_API_KEY=your-key
#    PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
#    PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
#    HTTPS_PROXY=http://127.0.0.1:7897  # Muse 必须经项目 HTTP CONNECT 代理
#
#    副模型（多模态图像分析，可选）
#    PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
#    PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
#    PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-key

# 3. 默认日更脚本阶段：数据流程 + 博客三阶段 + 视觉输入准备
# 所有项目脚本必须在沙箱外运行；脚本入口会拒绝 Codex 沙箱
today="$(TZ=Asia/Shanghai date +%F)"
./run-daily-digest.sh "$today"

# review 若发现内容问题，修正后从 review 阶段续跑
./run-daily-digest.sh 2026-05-08 --from review

# 4. Codex 使用内置 image_gen 生成并登记全部视觉任务，最后验收
npm run visual:status -- --date 2026-05-08
npm run cover:status -- --date 2026-05-08

# 5. 可选：生成小红书文案
python3 scripts/publish-xiaohongshu.py
```

完整安装指南见 [`docs/setup.md`](docs/setup.md)。

---

## 8. 常用命令速查

### npm scripts

```bash
# 默认日更脚本阶段（随后由 Codex 接续内置生图）
npm run digest:prepare -- "$(TZ=Asia/Shanghai date +%F)"

# 仅数据流程（抓取 + 筛选 + 深度分析）
npm run fetch

# 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
npm run deep

# 历史批次重新筛选并重分析；同步正式快照并剥离旧 Manual-only provenance
node scripts/refilter-reanalyze-by-date.js YYYY-MM-DD

# 全量重分析
npm run reanalyze

# 批量分析未分析论文
npm run batch

# 只读校验当前 JSON 数据结构（含筛选决策缓存一致性）
npm run validate:data
# 没有运行数据的干净 checkout 才使用：
# npm run validate:data -- --allow-empty
npm run keyword:recall
npm run digest:status -- --date YYYY-MM-DD

# 全部博客发布后，幂等建立/续跑 TOP 10 论文长图与汇总图任务
npm run visual:post-publish -- --date 2026-04-21
npm run visual:prepare -- --date 2026-04-21
npm run visual:status -- --date 2026-04-21
npm run cover:status -- --date 2026-04-21

# 运行单元测试
npm test

# 补录历史 paper ID
npm run backfill

# 博客三阶段：生成 → 审查 → 推送（三个入口不会互相重复执行）
npm run blog:generate -- --date 2026-04-21
npm run blog:generate -- --date 2026-04-21 --exclude-id 2607.12345  # 可重复传入，仅排除本次发布
npm run blog:review -- --date 2026-04-21
npm run blog:push -- --date 2026-04-21

# 只有显式要求人工高保障路线时才运行；完整命令见 manual/README.md
npm run digest:manual -- 2026-04-21

# 生成微信公众号草稿
npm run wechat
# 仅生成公众号预览，不调用微信接口
python3 scripts/publish-wechat-full.py --dry-run
# 发布输入文件全部论文到公众号草稿
python3 scripts/publish-wechat-full.py --all

# 生成小红书文案
npm run xiaohongshu

# 小红书自动发布（需先登录）
npm run xhs-login
npm run xhs-publish
npm run xhs-publish-all

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
# 仅预览飞书文档规模，不创建文档
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
# 发布输入文件全部论文到飞书
python3 scripts/publish-to-feishu.py --all
```

### 直接调用

```bash
# ========== 核心流程 ==========
# 默认日更脚本阶段（之后由 Codex 接续内置生图）
./run-daily-digest.sh "$(TZ=Asia/Shanghai date +%F)"

# 仅数据流程
./run-full-fetch.sh

# 或直接用 Node
node scripts/full-fetch.js

# 抓取/筛选中断后直接重跑：fetch-checkpoint 按来源补抓，筛选只重试未决论文
# 模型或 filter prompt 改变时复用健康候选，只重新筛选

# 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
# 每个分析阶段都在单篇锁内即时落盘，崩溃后只从首个未完成阶段续跑
node scripts/deep-analysis-only.js

# 全量重分析
node scripts/reanalyze.js

# 指定并发度重分析
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# 批量分析未分析论文
node scripts/batch-analyze.js

# 单独分析一篇论文
node scripts/analyze-single-paper.js 2604.16044 --force

# 只读校验当前数据结构
node scripts/validate-data-files.js

# ========== 发布 ==========
# 博客生成、review、push 必须依次使用独立脚本
python3 scripts/generate-blog.py --date 2026-04-21
python3 scripts/review-blog.py --date 2026-04-21
python3 scripts/push-blog.py --date 2026-04-21

# 显式 Manual/人工流程的完整命令、shadow、legacy 与恢复规则见 manual/README.md
npm run digest:manual -- 2026-04-21

# 用自定义数据发布
python3 scripts/generate-blog.py --date 2026-04-21 data/current/deep-analysis-result.json
python3 scripts/generate-blog.py --all data/current/deep-analysis-result.json

# 生成微信公众号草稿
python3 scripts/publish-wechat-full.py
python3 scripts/publish-wechat-full.py --dry-run

# 用自定义数据生成微信草稿
python3 scripts/publish-wechat-full.py data/current/deep-analysis-result.json
python3 scripts/publish-wechat-full.py --all data/current/deep-analysis-result.json

# 生成小红书文案（默认 TOP 5）
python3 scripts/publish-xiaohongshu.py
python3 scripts/publish-xiaohongshu.py --top 7
python3 scripts/publish-xiaohongshu.py --all

# TOP N 一句话默认 5 并发，可在项目 .env 设置 1-5
# PD_XIAOHONGSHU_ONELINER_CONCURRENCY=5
# 成功 one-liner 会逐篇缓存；重跑只请求失败、缺失或指纹变化的论文

# 小红书自动发布（需先登录）
python3 scripts/xiaohongshu-publisher.py --login
python3 scripts/xiaohongshu-publisher.py
python3 scripts/xiaohongshu-publisher.py --all

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
python3 scripts/publish-to-feishu.py --all

# ========== 辅助 ==========
# 补录论文 ID（不分析）
python3 scripts/backfill_papers.py

# 按日期重新筛选 + 分析
node scripts/refilter-reanalyze-by-date.js 2026-07-01
```

---

## 更多文档

- [主流程详解](docs/workflow.md) — 自动归档、抓取、筛选、深度分析的完整流程
- [脚本分工](docs/scripts.md) — 全部脚本的功能说明与用法
- [数据格式](docs/data-format.md) — fetch checkpoint、筛选缓存、逐阶段分析 checkpoint、博客凭证和小红书文案缓存结构
- [安装与配置](docs/setup.md) — 依赖安装、环境变量、模型配置、日志机制
- [排错手册](docs/troubleshooting.md) — API 错误、代理问题、发布失败的排查方法
- [维护约定](docs/maintenance.md) — 代码规范、评分标签口径、变更检查清单
- [显式 Manual 路线](manual/README.md) — production v6 工作流、编辑契约、review、shadow 与 legacy 边界

---

## 参考与致谢

- 本项目在设计和实现过程中参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) 的思路与结构
