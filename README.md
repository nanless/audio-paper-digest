# Paper Digest - 语音/音乐/音频论文速递全流程自动化

**[English](README.en.md)** | 中文

本项目用于生成“语音/音乐/音频论文速递”。默认日更采用 LLM/API 自动路线：联网抓取后执行关键词预筛、模型逐篇筛选、多阶段全文分析、证据约束评分、面向初学研究者的连续长文、博客 review/push 与发布后视觉。Production Manual v6 保留为用户显式选择的人工高保障路线。Node 端配置集中在 `scripts/config.js`，Python 发布路径集中在 `scripts/path_config.py`。

Production v6 根为 `data/current/manual-v6/<date>/`：`manual:fulltext` 保存结构化全文并生成 complete/incomplete ArtifactIndex；持久 runner 管理 author → technical_scoring / pedagogy_readability → author_revision，最多 3 个活动 claim，但不调用 API、不创建或冒充 subagent，也不自动物化 role packet 或 records envelope。主 Agent负责真实 Terra-high leaf subagent 和 `records-v4.json`；official assembler 回读 records v4 内嵌并重放的 legacy v5 base payload、ArtifactIndex、各 role packet/output/receipt 的真实字节，组装含完整论文集合与 Merkle root 的 spec v6。`manual:analyze` 以 `runtimeMode=production` 写标准 `data/current/deep-analysis-result.json`，publisher 缺 v6 binding 时 fail closed。显式 shadow 仍隔离在 `data/current/manual-v6-shadow/<date>/`；v5 只保留 `manual:v5:*` 历史只读/维护兼容。

本轮 P0 同时修复了 Manual 同日期重复进程、HF 同步 curl 阻塞、跨类别重复摘要、健康 arXiv 类别固定长等待，以及 generation schema v3 页面 SHA 未在 review/push 兑现的问题。Manual raw 的真实 socket 仍按 host 严格单飞，但冷却改为健康 1 秒、瞬时失败 5 秒、429 60 秒的自适应 next-eligible；等待只在下一次同 host 请求前支付，本地解析/checkpoint/HF 会自然抵消它。Production raw/fulltext/ArtifactIndex/spec/canonical 指标写 `manual-v6/<date>/metrics/`；只有显式 shadow 才写 `manual-v6-shadow/<date>/metrics/`。性能收益必须用新鲜联网批次的 P50/P95 证明。

逐论文筛选、理解、主要正文、评分、可读性复核和最终单页审查 subagent 统一使用 `gpt-5.6-terra`、reasoning `high`；Sol 主 Agent 只负责队列、代码、确定性门禁、组装和发布。正文任务包固定携带仓库内 [Manual 教程写作规范](prompts/manual-tutorial-article.md) 及其 SHA，参考依据已沉淀到 [Manual 教程编辑参考契约](docs/manual-editorial-reference-contract.md)，正常批次无需重新打开外部参考。新 record 必须显式写 `editorialPlan.readerFormatContract=graduate-researcher-tutorial-quality-v2`；缺字段仅兼容历史 plan。正文先建立“中心技术矛盾—递进读者问题—证据柱—结论回收”的编辑蓝图，再按论文主张组织图表和实验，而不是按字段或论文目录机械扩写。新 records 使用 `editorialPlan` v2：读者标题、核心判断、问题回答、证据柱和每节锚句都必须可在最终正文中逐一定位；`editorial.readerArticle` 则是发布页唯一的连续深度解读，用论文特有小节替代“方法/创新/实验/细节/局限”模板栏目。每条实验结论还须提供可直接给读者看的自然语言解释，不能把方法/基线/指标/数值拼成字段串。独立页固定按“中文题目 → 英文题目/arXiv 链接 → 标签 → 总分与八维分项 → 作者机构 → 一句话概括 → 毒舌点评 → 核心摘要 → 开源与复现资源 → 深度解读 → 文末逐维评分证据”组织，八个分项即使为 0 也不能省略；每日汇总卡片使用对应的紧凑身份信息。章节标题禁止包含图表编号，公式统一使用 `\(...\)` / `\[...\]`，最终 review 同时验证 Markdown 源码与 Hugo 渲染 HTML。毒舌点评必须同时给出最扎实的优点和最该泼冷水的不足，并由深度解读中的证据支撑。历史记录没有有效 `readerArticle` 时才兼容旧固定栏目；评分证据与扣分边界统一置于文末。

新教程还必须通过 `reader-tutorial-path-v1`：背景任务与真实失败例 → 相关工作谱系 → 本文可证伪问题 → 方法端到端全貌 → 数据/模型/目标组件 → 完整实验协议 → 主结果 → 诊断/消融 → 外部比较 → 能力边界 → 复现与行动。摘要可以预告重点，但正文不得在背景和方法尚未建立时直接进入最佳数字，也不得让术语、损失或关键变体在结果之后才首次解释。

教程作者任务固定使用 `fresh-authoring-v1` 冷启动：只读本篇 metadata、受控全文、ArtifactIndex、论文图表/公式、事实账本、写作契约和空白 schema；禁止读取历史 analysis、旧 `readerArticle`、`article.md`、`post.md`、博客 Markdown/HTML 或已填写质量包。旧文章不得进入教程生成、质量回归或修订输入，只能等待新页面验收后被精确替换；不能通过重排、扩写或清洗升级为新教程。review 后需要修正时，也必须从原始证据和结构化 findings 生成完整替换稿。

Production v6 的 records v4 内嵌并重放 legacy v5 base payload 作为基础质量子校验：`article.md`、`quality.json`、确定性 `artifact-plan.json` 与 complete ArtifactIndex 由 `manual-tutorial-validation-orchestrator-v1` 验证；records v4 再绑定 role task、`reader-longform-v2` 与 Merkle 语义。任一文件、SHA、论文身份、质量结果或工件处置漂移都会在 spec、canonical 或 publisher 边界失败；历史 v5 只读兼容，不可重新包装成新教程页。

Production review/revision 不把格式错误拖到 binder 或最终 records：新物化的 role packet 在自身稳定签名中内联固定输出/receipt 路径、必需字段、角色量表与 `stable-json-ascii-keys-exact-ieee754-nfkc-text-v2` 语义 SHA 算法；旧 packet 仅保留验证兼容。runner 在 `technical_scoring` submit 时直接拒绝缺失正式八维评分、0–10 自创量表、非法开源锚点或不完整 calibration 的输出，在 `author_revision` submit 时重放 6–32 个 blocks，并要求正式 `tables`、`figures`、`formulas` 对 complete ArtifactIndex 逐项闭环，正文实际使用的 `terms` 全部定义，`relatedWorks` 至少绑定两个真实引用。`artifactCoverage` / `tableCoverage` 等旧摘要字段不是 V6 longform 的替代品；显式 retry/abandon 后只能原子替换目标 packet，其他已绑定工件继续 fail closed。

`npm run manual:bind-revision -- --date YYYY-MM-DD --paper <arXiv ID>` 是 production revision 的确定性封装器：Terra-high leaf 提交终稿与 `manual-v6-revision-binding-map-v1` 小型语义映射；未封印 base payload 只能从当前 runner-validated `draft/author-record.json` 构造。binder 永不读取自己上一次遗留的 `draft/revision-record-payload.json`，即使该文件存在也只可被覆盖，防止“冷启动 revision”暗中继承旧 prose、评分或 review binding。封装器按 `###` 标题逐字拆 block，移除局部手抄 Markdown 表并注入 ArtifactIndex 的精确矩阵，从 runner 已验证输出回填八维评分和七维可读性，并把 draft 中合法的 `E1` 风格 evidence ID 连同全部精确依赖引用原子规范化为最终 `E01` 风格（冲突即失败）。早期 V6 author 产物若只有稳定的有序对象 ledger 而遗漏 ID，binder 仅按原始顺序确定性分配 `E01…`；若使用 `dataset` / `metric-v2` 一类唯一安全短标签，则同时绑定标签与审查阶段的顺序别名 `E1…`，再一次性改写为最终 ID。缺少 ledger、把 provenance 对象冒充 ledger、路径式/含空白/过长/冲突标签都会失败并返回 author 重做。新 author output 已在 submit 门禁强制要求显式 E ID。随后封装器生成正式 longform、output、receipt 和所有 SHA。它不生成或改写论文论点，缺少图像像素事实、公式解释、术语定义或相关工作差异时仍 fail closed。

Production v6 的 fresh packet 与 records v4 会重放 legacy v5 base validator 的文件凭证：受控 `article.md` 原始/NFKC SHA、filtered metadata、完整全文、complete ArtifactIndex、教程 prompt、编辑契约、空白 schema 和可选官方项目证据必须逐项闭环；随后 v6 task/longform/records bindings 再次封印。这里的 v5 仅是历史基础质量子校验，不是默认运行时。

新 canonical 的来源复用键是 `manual-paper-source-identity-v1`：只包含本篇全文、图片、结构化快照和 ArtifactIndex 的语义/文件身份。日期级 manifest 仍检查整批集合和健康状态，但另一篇 entry 更新不会再让本篇 canonical 失效；本篇任一证据字节变化仍会被严格拒绝。历史只读兼容不适用于已经声明 fresh/tutorial 的页面。

用户明确取消发布后图片时，运行 `npm run digest:waive-visuals -- --date YYYY-MM-DD --reason "用户明确取消视觉资产"` 记录与远端发布 commit 及当前视觉任务 SHA 绑定的可审计豁免；它不会生成图片，也不会把 pending 资产伪装成 complete。

LLM endpoint 必须使用 HTTPS（仅 loopback 本地测试允许 HTTP）。arXiv 元数据抓取的重试、退避、累计等待、绝对截止、响应字节上限与 User-Agent 均由 `ARXIV_CONFIG` 管理，覆写项见 [环境配置](docs/setup.md)。

对 Codex 说“运行/进行某一天的论文速递”，默认含义是运行 `npm run digest:prepare -- YYYY-MM-DD`，即 LLM/API 自动抓取、筛选、全文分析、评分校准、读者长文、博客 review/push、TOP 10 论文长图、汇总封面和最终状态验收。`digest:api` 是同义入口；只有明确说“使用 Manual/人工流程”时才运行 `npm run digest:manual -- YYYY-MM-DD`。博客发布无需再次确认；其他发布渠道不在默认范围。

Manual 写作采用 3-worker 饱和队列：主 Agent 之外的 3 个并发槽持续各处理 1 篇论文，完成即补位。普通独立二审不会与正文争抢槽位；只有高分、内部无消融、满分自评或来源/图片异常的风险论文会提前触发二审。

深度分析采用 `type-aware-v1` 类型感知评分：先将文档归类为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究或应用研究，再按对应证据标准评审。八维权重、满分 11 和总分封顶 10 保持统一；分项与总分最多一位小数，开源分使用固定锚点。文档类型不提供固定加分，同一个缺陷只能在一个主要维度扣分；理论工作的完整证明材料可作为核心公开产物，不会因没有代码/模型/数据而被机械归零。

视觉摘要位于发布流程之后：先完成全部论文深度分析，再生成、review 并 push 全部博客（汇总页和所有论文页）。`push-blog.py` 验证远端 `main` OID 后自动建立可恢复视觉任务，只为最终评分 TOP 10 的论文各生成一张纵向 PNG 长图；同分按规范化 arXiv ID 稳定排序。长图顶部逐字显示英文论文标题，正文用约 220–360 个简体中文字符完整串联研究问题、方法、实验、结论与局限。若深度分析已筛选并缓存可靠的论文方法总览图、架构图或关键结果图，任务会绑定最多两张参考图及其 SHA。最终图片由内置生图直接完成标题、中文说明、结构图、实验数据和纸张拼贴艺术的一体化构图，不再经过旧的确定性文字卡片合成器；登记前必须逐项目检标题、文字、箭头关系、指标方向和数值，存在不可读或实质错误时重新生成。论文长图和汇总封面统一采用暖白底、低饱和配色和充足留白的清新纸张编辑风，通过细微纸纹、纸片叠层、局部毛边、少量胶带和柔和投影建立设计层次；明确禁止脏旧复古、拥挤手账、深色霓虹、赛博 HUD 和仪表盘式排版。

发布后还生成一张批次汇总图，标题、热门方向和 TOP 10 排行榜均从已发布批次对应的审计数据确定性计算。论文长图与汇总图独立绑定数据、prompt、任务 token 和资产 SHA；重跑只补失败、缺失、损坏或指纹失效项。同一天全部生成图片扁平归档到 `data/archive/<日期>/visual-summaries/`：封面为 `00-digest-cover-<日期>.png`，论文长图为 `<两位排名>-<paper-id>-<title-slug>.png`，严格按最终 rank 而非生成完成顺序编号；图片不滞留在 current。它们不进入已经发布的博客清单，也不构成博客 generate/review/push 的前置门禁。

LLM 筛选前默认执行高召回关键词预筛，核心音频类别提供兜底，明显无关论文不会消耗 LLM 配额。`npm run keyword:recall` 同时校验人工正负金标与历史有效正样本；已确认的历史 LLM 误筛必须显式记录理由，不计入有效正样本分母。日更结束后运行 `npm run digest:status -- --date YYYY-MM-DD`，统一验收抓取、筛选、分析、博客远端发布和两类视觉资产，并保存机器可读报告。报告只反映命令执行时刻；后续 push 或视觉 `record` 后必须重跑，不能把旧报告当作实时状态。历史日期在 current 滚动后读取同日 archive，但只有 raw/decisions/filtered/deep 的批次、逐篇决定覆盖和论文集合全部一致才会报告完整；当前日期不会回退 archive。

深度分析采用分阶段证据预算控制 token：主分析仍覆盖全文，超长论文按全文位置和任务关键词均衡取样；开源扫描、审校重写、评分审计、方法/表格和结构修复只接收各自相关的证据切片。新分析和重分析必须通过版本化硬契约：`evidence-rich-v2` 在 `bounded-v1` 的最多 2 张表、每表 12 个数据行、8 个指标列与列数一致性上，进一步要求设置/数据集/基线字段、至少 3 行证据和 2 个数字、指标方向、表前比较问题、表后关键差异与证据边界，并在全文提供时覆盖消融或负面结果；`detailed-v1` 要求方法章节至少 600 个中文字符、三个有效段落和明确结构描述。历史 `bounded-v1` 与无标记成功记录保持原语义兼容。博客 review 独立论文页并发度限制为 1–5；微信、飞书和小红书在默认数据源下必须绑定同日博客 generation manifest 与远端验证 receipt 的 `publishedPapers` 权威快照，清单缺失也会失败；明确独立运行须传 `--ignore-blog-snapshot`。视觉登记必须在逐项核对 `qaClaims` 后显式传 `--qa-attested true`，声明随资产写入 manifest 且缺失或损坏时完成态失效。

显式 API/LLM 路线会在评分阶段生成结构化 `evidenceProfile`，再由代码按消融、评测范围、样本规模与部署测量应用可解释上限，降低“文字写得像高分但证据没有跟上”的偏差。事实与评分闭环后，独立的 `beginner-researcher-v1` 读者文章阶段以论文特有标题重组背景、方法、实验与边界；旧 13 节 canonical 继续承担机器解析兼容，博客优先展示这篇连续长文。

---

标准日更会在任何 Git 变更前检查 generation schema v3 与 `publishedPapers` 视觉能力；schema v1/v2 仅用于显式历史维护，review receipt 标记视觉 N/A。相同非空 generation 可整链幂等重跑，但复用发布凭证前会重新校验当前 review 协议、文件与提交，并实时确认当前 remote 身份和远端 `main` OID；网络失败、远端分支漂移或 `origin` 换仓都会拒绝复用。渠道发布按目标博客发布日期绑定远端已验证的 `publishedPapers`，保留论文原始抓取批次；current 已滚动时回退日期归档，自定义输入也只有显式 `--ignore-blog-snapshot` 才能绕过快照。

## 文档说明

| 文件 | 用途 | 读者 |
|------|------|------|
| `README.md` | 项目概览、快速开始、命令速查 | 人类用户 |
| `SKILL.md` | 给 Agent 的执行规则与安全约束 | AI Agent |
| `docs/workflow.md` | 主流程详解（归档、抓取、筛选、分析、保存） | 使用者 |
| `docs/manual-v6-migration.md` | Manual 提质加速改造、契约、缓存 DAG 与迁移边界 | 维护者 |
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
| `prompts/api-reader-article.md` | API 路线初学研究者长文（动态问题标题、学习依赖顺序、事实与文风硬门禁） | 维护者 |

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

# 历史批次重新筛选并重分析；同步归档中的正式 decisions/filtered 快照
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

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 补录历史 paper ID
npm run backfill

# 博客三阶段：生成 → 审查 → 推送（三个入口不会互相重复执行）
npm run blog:generate -- --date 2026-04-21
npm run blog:generate -- --date 2026-04-21 --exclude-id 2607.12345  # 可重复传入，仅排除本次发布
npm run blog:review -- --date 2026-04-21
npm run blog:push -- --date 2026-04-21

# 单篇灰度：生成、Manual attestation/review、push 全部使用同一个规范化 ID
# 只替换这一篇论文页，不生成/修改汇总页，也不删除同日其他论文页；不调用普通 LLM review
npm run blog:generate -- --date 2026-04-21 --include-id 2604.12345
npm run blog:manual-plan -- --date 2026-04-21 --include-id 2604.12345
# 按 plan 输出的隔离 shardDir 写入这一页的 Terra-high review shard，然后组装
npm run blog:manual-attest -- --date 2026-04-21 --include-id 2604.12345
npm run blog:manual-review -- --date 2026-04-21 --include-id 2604.12345 \
  --attestation <manual-plan 输出的隔离 attestationPath>
npm run blog:push -- --date 2026-04-21 --include-id 2604.12345

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

# 显式 Manual 流程使用完整 provenance 的逐页审查；每页必须由独立 review subagent 完成
# 当前 attestation v3 逐文件绑定 path/SHA、subagent、独立 notes、八类 checks 和每张图的像素事实；v2 仅历史兼容
python3 scripts/manual-review-blog.py --date 2026-04-21 --attestation data/current/manual-review-attestation-2026-04-21.json
# 单篇灰度先用 --plan 获取带日期、论文 ID 和身份哈希的隔离 shard/attestation 路径；
# assemble、manual review 和 push 必须继续传同一个 --include-id，禁止回退读取日期整批凭证
npm run blog:manual-plan -- --date 2026-04-21 --include-id 2604.12345

# 人工全文先逐篇安全抓取并 checkpoint；失败后重跑只补失败或损坏项
npm run manual:fulltext -- 2026-04-21

# 初始化 production v6 task runner；它不会创建 subagent、packet 或 records envelope
npm run manual:tasks -- init --date 2026-04-21
npm run manual:tasks -- status --date 2026-04-21
# 每个 role 在分派前由主 Agent物化 exact-allowlist packet；命令会返回精确 register 参数
npm run manual:packet -- --date 2026-04-21 --paper 2604.12345 --role author
# 四角色全部由真实 Terra-high task 验证后，确定性密封 records v4 envelope
npm run manual:records -- --date 2026-04-21
npm run manual:spec -- --date 2026-04-21 \
  --records data/current/manual-v6/2026-04-21/records-v4.json
# spec v6 写在同日 production 根；ingestion 以 runtimeMode=production 写标准 canonical
npm run manual:analyze -- --date 2026-04-21 \
  --spec data/current/manual-v6/2026-04-21/spec.json

# production v6：records v4 必须由逐论文真实任务产出，不能把 legacy v5 record 改版本号冒充
npm run manual:v6:spec -- --date 2026-04-21 \
  --records data/current/manual-v6/2026-04-21/records-v4.json
npm run manual:v6:analyze -- --date 2026-04-21 \
  --spec data/current/manual-v6/2026-04-21/spec.json

# 显式 shadow：只写 manual-v6-shadow/<date>/，不能发布
npm run manual:v6:shadow:spec -- --date 2026-04-21 \
  --records data/current/manual-v6-shadow/2026-04-21/records-v4.json
npm run manual:v6:shadow:analyze -- --date 2026-04-21 \
  --spec data/current/manual-v6-shadow/2026-04-21/spec.json

# legacy v5：仅历史只读/维护，禁止与 production v6 混批
npm run manual:v5:spec -- --date 2026-04-21 --records LEGACY_RECORDS_V3.json
npm run manual:v5:analyze -- --date 2026-04-21 --spec LEGACY_SPEC_V5.json

# 持久任务状态机不启动 subagent；主 Agent只按 status/claim 输出逐篇分派 Terra-high task
npm run manual:v6:tasks -- init --date 2026-04-21
npm run manual:v6:tasks -- status --date 2026-04-21

# production v6 status：不创建 subagent；缺 packet/envelope 时 fail closed
npm run manual:work-queue -- --date 2026-04-21

# runner 不代做 packet/records；主 Agent按状态显式调用 manual:packet/manual:records

# 跨批次只读性能验收；每项不足 3 个不同日期只报 insufficient_data
npm run manual:performance-report -- \
  --date 2026-04-19 --date 2026-04-20 --date 2026-04-21
# 默认只打印；仅显式 --output 才写入受控 observability 目录且禁止覆盖
npm run manual:performance-report -- --output observed-three-batches.json

# 对既有批次做无副作用审计；少于 3 个真实报告时 benchmark 只返回 insufficient_samples
npm run manual:shadow -- --date 2026-04-21 \
  --metrics data/current/manual-v6-shadow/2026-04-21/metrics/fulltext-<run-id>.json \
  --metrics data/current/manual-v6-shadow/2026-04-21/metrics/artifact_index-<run-id>.json \
  --output data/current/manual-v6-shadow/reports/2026-04-21.json
npm run manual:shadow:benchmark -- \
  --report data/current/manual-v6-shadow/reports/2026-04-19.json \
  --report data/current/manual-v6-shadow/reports/2026-04-20.json \
  --report data/current/manual-v6-shadow/reports/2026-04-21.json

# 上述显式 shadow 审计只消费 manual-v6-shadow/<date>/metrics/；production 指标位于 manual-v6/<date>/metrics/。
# wallMs 来自 process.hrtime.bigint；只有实际可测的锁等待才有 queueMs，其余为 unknown。
# 每份 sidecar 绑定真实 input/output bytes 与 SHA；shadow 重验后才允许进入 benchmark。
# v6 签名对象采用 stable-json-ascii-keys-exact-ieee754-nfkc-text-v2：Unicode 字符串值受支持，
# 有限浮点按 IEEE-754 实际值写成精确十进制；非 ASCII key、NaN/Infinity、负零和非安全整数 fail closed。

# titleOverride 仅可修复元数据标题的空白粘连。存在合格候选时必须显式给出 selectedImageUrls；
# 每张选图还须给出同序 imageInsertions，以唯一 anchorQuote/conclusionQuote 绑定同节前后论证，
# lead 提出具体读图任务，explanation 指出图中可见证据与结论边界。空数组、自动选择和通用免责声明均会被拒绝。

# 无筛选模型的人工接管：--raw 仍联网抓取并生成带来源指纹的候选全集，再逐篇提交 related 决定
node scripts/manual-fetch.js --date 2026-04-21 --raw
node scripts/manual-fetch.js --date 2026-04-21 --select data/current/manual-filter-spec-2026-04-21.json

# review 首次失败后，修复页面并重跑同一命令；已通过且 SHA 未变的页面永久复用
# 只复审新增、内容变化、待重试或已修复的失败页；最终仍对完整批次执行确定性校验和 Hugo gate
# 发布视图会剥离内部评分锚点；确定性层还检查近重复、半词图注、反引号公式与英文毒舌点评
# manual-review-blog.py 是显式 manual_complete 模式：仍执行逐文件哈希、基线、协议、确定性检查和 Hugo gate，
# 并把逐页技术叙事/事实/实验/复现/局限/评分/图片的人工语义声明写入 receipt，模式为 manual_semantic；
# 确定性层若修改任一页面，旧声明立即失效；push 会重验逐文件集合和 SHA，不能把批次级勾选或普通 LLM 故障静默视为通过。

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
