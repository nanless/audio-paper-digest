# Paper Digest - 语音/音乐/音频论文速递全流程自动化

**[English](README.en.md)** | 中文

本项目用于自动生成"语音/音乐/音频论文速递"，覆盖从 arXiv 和 HuggingFace Papers 抓取、LLM 筛选、多模态深度分析，到发布 Hugo 博客、微信公众号草稿、小红书文案和飞书文档的完整链路。Node 端可调参数和当前运行数据文件路径集中在 `scripts/config.js`；Python 发布/维护脚本的共享路径集中在 `scripts/path_config.py`。

对 Codex 说“运行/进行某一天的论文速递”，默认含义是完成抓取、筛选、深度分析、博客生成、review 与修正、博客发布、TOP 10 论文长图、汇总封面和最终状态验收。博客发布无需再次确认；微信公众号、飞书和小红书自动发布不包含在这个默认范围内。

深度分析采用 `type-aware-v1` 类型感知评分：先将文档归类为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究或应用研究，再按对应证据标准评审。八维权重、满分 11 和总分封顶 10 保持统一；分项与总分最多一位小数，开源分使用固定锚点。文档类型不提供固定加分，同一个缺陷只能在一个主要维度扣分；理论工作的完整证明材料可作为核心公开产物，不会因没有代码/模型/数据而被机械归零。

视觉摘要位于发布流程之后：先完成全部论文深度分析，再生成、review 并 push 全部博客（汇总页和所有论文页）。`push-blog.py` 验证远端 `main` OID 后自动建立可恢复视觉任务，只为最终评分 TOP 10 的论文各生成一张纵向 PNG 长图；同分按规范化 arXiv ID 稳定排序。长图顶部逐字显示英文论文标题，正文用约 220–360 个简体中文字符完整串联研究问题、方法、实验、结论与局限。若深度分析已筛选并缓存可靠的论文方法总览图、架构图或关键结果图，任务会绑定最多两张参考图及其 SHA。最终图片由内置生图直接完成标题、中文说明、结构图、实验数据和纸张拼贴艺术的一体化构图，不再经过旧的确定性文字卡片合成器；登记前必须逐项目检标题、文字、箭头关系、指标方向和数值，存在不可读或实质错误时重新生成。论文长图和汇总封面统一采用暖白底、低饱和配色和充足留白的清新纸张编辑风，通过细微纸纹、纸片叠层、局部毛边、少量胶带和柔和投影建立设计层次；明确禁止脏旧复古、拥挤手账、深色霓虹、赛博 HUD 和仪表盘式排版。

发布后还生成一张批次汇总图，标题、热门方向和 TOP 10 排行榜均从已发布批次对应的审计数据确定性计算。论文长图与汇总图独立绑定数据、prompt、任务 token 和资产 SHA；重跑只补失败、缺失、损坏或指纹失效项。同一天全部生成图片扁平归档到 `data/archive/<日期>/visual-summaries/`：封面为 `00-digest-cover-<日期>.png`，论文长图为 `<两位排名>-<paper-id>-<title-slug>.png`，严格按最终 rank 而非生成完成顺序编号；图片不滞留在 current。它们不进入已经发布的博客清单，也不构成博客 generate/review/push 的前置门禁。

LLM 筛选前默认执行高召回关键词预筛，核心音频类别提供兜底，明显无关论文不会消耗 LLM 配额。`npm run keyword:recall` 同时校验人工正负金标与历史有效正样本；已确认的历史 LLM 误筛必须显式记录理由，不计入有效正样本分母。日更结束后运行 `npm run digest:status -- --date YYYY-MM-DD`，统一验收抓取、筛选、分析、博客远端发布和两类视觉资产，并保存机器可读报告。

深度分析采用分阶段证据预算控制 token：主分析仍覆盖全文，超长论文按全文位置和任务关键词均衡取样；开源扫描、审校重写、评分审计、方法/表格和结构修复只接收各自相关的证据切片，不再重复发送整篇论文。博客文本 review 默认由 4000 字提高到 8000 字一块，以减少每块重复的固定审查说明；所有预算都可在项目 `.env` 覆写并绑定恢复指纹。

---

## 文档说明

| 文件 | 用途 | 读者 |
|------|------|------|
| `README.md` | 项目概览、快速开始、命令速查 | 人类用户 |
| `SKILL.md` | 给 Agent 的执行规则与安全约束 | AI Agent |
| `docs/workflow.md` | 主流程详解（归档、抓取、筛选、分析、保存） | 使用者 |
| `docs/scripts.md` | 全部脚本功能说明 | 开发者 |
| `docs/data-format.md` | 数据文件格式与字段说明 | 开发者 |
| `docs/setup.md` | 安装初始化、环境变量、日志、代理配置 | 新用户 |
| `docs/troubleshooting.md` | 常见问题排查与修复 | 使用者 |
| `docs/maintenance.md` | 维护约定、评分标准、标签口径 | 维护者 |
| `prompts/filter.md` | 筛选阶段 LLM prompt | 维护者 |
| `prompts/deep-analysis.md` | 深度分析主 prompt（Round 1，纯文本） | 维护者 |
| `prompts/image-supplement.md` | 图像筛选与插图计划 prompt（双模型模式；默认最多 4 张并使用稳定段落 ID，只新增图前/图后说明） | 维护者 |
| `prompts/visual-summary.md` | 发布后 TOP 10 论文纵向长图 prompt | 维护者 |
| `prompts/digest-cover.md` | 发布后汇总图 prompt（标题 + 热门方向 + TOP 10 排行榜） | 维护者 |
| `prompts/opensource-scan.md` | 开源链接扫描 prompt（Round 2） | 维护者 |
| `prompts/gap-fill.md` | 审校重写 prompt（Round 3） | 维护者 |
| `prompts/structure-repair.md` | 缺失必要章节时的主模型局部结构修复 prompt | 维护者 |
| `prompts/scoring-audit.md` | 主模型最终类型感知评分审计（送审前移除旧评分理由，仅依据正文与证据账本重建评分字段与理由） | 维护者 |

> **铁律**：真实行为以 `scripts/*.js` / `scripts/*.py` 当前实现为最终准绳。若文档与代码冲突，以代码为准并修正文档。

---

## 项目结构

```
audio-paper-digest/
├── scripts/              # 全部脚本
├── tests/                # 单元测试
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
#    PAPER_ANALYZER_MODEL=deepseek-v4-pro
#    PAPER_ANALYZER_ENDPOINT=https://api.deepseek.com/anthropic
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

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 补录历史 paper ID
npm run backfill

# 博客三阶段：生成 → 审查 → 推送（三个入口不会互相重复执行）
npm run blog:generate -- --date 2026-04-21
npm run blog:generate -- --date 2026-04-21 --exclude-id 2607.12345  # 可重复传入，仅排除本次发布
npm run blog:review -- --date 2026-04-21
npm run blog:push -- --date 2026-04-21

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

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

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

# review 首次失败后，修复页面并重跑同一命令；安全条件满足时只复审已修改的失败页
# 最终仍会对完整批次执行确定性校验和 Hugo gate

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

---

## 参考与致谢

- 本项目在设计和实现过程中参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) 的思路与结构
