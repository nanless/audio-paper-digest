<p align="center">
  <img src="docs/images/hero-workbench.zh.svg" alt="音频研究工作台 · Audio Research Workbench" width="100%" />
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> ·
  <a href="https://nanless.github.io/audio-research-portal/">🌐 音频研究门户（在线阅读）</a> ·
  <a href="https://github.com/nanless/audio-research-workbench/releases">📦 下载 Mac / Android 客户端</a> ·
  <a href="docs/README.md">📚 文档总索引</a>
</p>

<p align="center">
  <a href="https://nanless.github.io/audio-research-portal/"><img src="https://img.shields.io/badge/Live_Portal-音频研究门户-0f766e?style=flat-square" alt="音频研究门户" /></a>
  <a href="https://github.com/nanless/audio-research-workbench/releases"><img src="https://img.shields.io/badge/Client-v1.5.0_(Build_24)-1d4ed8?style=flat-square" alt="Client v1.5.0" /></a>
  <img src="https://img.shields.io/badge/macOS-15%2B_Apple_Silicon-334155?style=flat-square" alt="macOS 15+" />
  <img src="https://img.shields.io/badge/Android-9%2B_(4_ABIs)-334155?style=flat-square" alt="Android 9+" />
  <img src="https://img.shields.io/badge/Archive-9%2C300%2B_已核验论文-4338ca?style=flat-square" alt="9,300+ Verified Papers" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-15803d?style=flat-square" alt="MIT License" /></a>
</p>

<a id="你会得到什么"></a>

语音、音乐、声学与 Audio LLM 方向每天都在 arXiv 和顶会涌出几十篇新论文——只扫摘要容易错过关键约束，逐篇精读原 PDF 又往往耗掉整个上午。

**音频研究工作台（Audio Research Workbench）**把这件事拆成一条**从原始论文出发、每处数字与原图都可追查来源**的开源研究系统：

- **后台内容引擎（本仓库）**：默认调用语言模型服务（LLM/API）完成抓取去重、筛选、四文件来源封存、深度分析、八维评分、九维分类与面向初学研究者的中文精读长文（代码中称 **Reader**），通过三层审查门禁后才推送发布。
- **公开知识站点（[音频研究门户 / Audio Research Portal](https://nanless.github.io/audio-research-portal/)）**：已持续归档 **9,300+ 篇**语音/音乐/声学论文精读、每日音频研究汇总、顶会专题与 8 大方向 SOTA 索引，支持浏览器全文检索、图注放大、表格排序与 BibTeX / RIS 一键引用。
- **双端原生阅读应用（macOS & Android）**：只读订阅门户静态快照，打开论文即看图文精读与原 PDF 对照，支持离线检索、每日音频播客、结构化笔记、按需自配模型追问、Zotero 归档与 WebDAV 版本化同步。

---

## ✨ 眼见为实：音频研究门户长什么样？

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://nanless.github.io/audio-research-portal/">
        <img src="docs/images/portal-home-preview.png" alt="音频研究门户首页实景：每日音频研究精选、快速检索与顶会入口" width="100%" />
      </a>
      <p align="center"><sub><strong>音频研究门户首页</strong> · 每日音频研究精选、全文速查、9 维主题谱系与顶会论文集</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://nanless.github.io/audio-research-portal/">
        <img src="docs/images/portal-paper-preview.png" alt="音频研究门户单篇论文精读页实景：音频参数卡、八维评分与公式原图" width="100%" />
      </a>
      <p align="center"><sub><strong>单篇深度精读页</strong> · 音频信号速览卡、八维拆解评分、KaTeX 公式与原图自然衔接</sub></p>
    </td>
  </tr>
</table>

### 为什么不是又一个“AI 摘要搬运站”？

| 常见痛点 | 音频研究工作台的做法 |
|---|---|
| 摘要堆砌术语，看不清方法到底怎么跑通 | 每篇公开 **Reader** 长文控制在 **5,000–18,000 中文字**，直接按具体问题、核心机制与实验发现组织 5–9 节，附结构化实现规格与可选术语桥；面向程序审计的 13 节内部主分析与 Reader 分开保存，互不替代。 |
| 数字幻觉、公式写错、图片张冠李戴 | 写作前先把每篇入选论文的官方 HTML 与 PDF 封存为四文件并计算 SHA-256；表格逐格回查原文、展示公式由程序写入原 TeX、原图逐张做图文事实核验，不凭空补数字或改图号。 |
| “开源链接打不开”或“篇篇 9 分” | 逐项核验代码、模型与 Demo 页的可达性，仅实测 `available` 才写“已开源/可用”；评分采用 **8 维分类型加权（`type-aware-v2`）** 并由代码重算封顶，方法、基准与综述各有对应权重。 |
| 推上去才发现网页 404 或排版炸了 | 严格执行 `生成 → 三层审查 → 精确差异推送 → Pages 部署确认 → 逐页 HTTP 200 与标题核验`，任一环节未过均阻断放行。 |

---

## 🎯 30 秒找到你的入口

| 你想做什么 | 从这里直接开始 |
|---|---|
| 🌐 在浏览器免费读 9,300+ 篇中文精读 | 打开 **[音频研究门户](https://nanless.github.io/audio-research-portal/)** · 引用与离线下载见 [网页阅读资料](docs/blog-reading-tools.md) |
| 💻 在 Mac 上双栏对照 PDF、记笔记与归档 Zotero | 查看 **[Mac 版使用说明](apps/macos/README.md)**（Apple Silicon，macOS 15+，开箱即用无需 `.env`） |
| 📱 在 Android 手机 / 平板上离线阅读与听每日播客 | 查看 **[Android 版使用说明](apps/android/README.md)**（Android 9+，全 4 种 ABI 架构） |
| 🗺️ 10 分钟理清项目整体数据与流程关系 | 阅读 **[项目导读](docs/project-guide.md)** |
| 🛠️ 部署内容生产引擎，自己跑日更 / 顶会 / 历史更新 | 完成下方 **[第一次使用](#第一次使用)**，再按 **[操作手册](SKILL.md)** 执行 |

---

## 🏗️ 三层架构：为什么阅读永远不消耗生产配额

![音频研究工作台三层架构：内容生产引擎、音频研究门户与双端原生客户端](docs/images/workbench-architecture.zh.svg)

项目把**内容生产**、**公开门户**与**个人研究**彻底切分为三个隔离层：

1. **① 内容生产引擎（本仓库）**：驱动**当天日更**、**官方会议整理**和**历史博客更新**三条产线，各自维护独立来源封存与去重基线，经审查凭证向门户仓库精确推送差异。
2. **② 音频研究门户（Hugo 静态站点）**：承载公开网页、400 项九维音频分类目录、8 大方向 SOTA 枢纽、Pagefind 检索与内容寻址客户端快照（`client/details/*`），同时保留 `/audio-paper-digest-blog/` 历史地址兼容。
3. **③ 音频研究工作台双端原生客户端（macOS / Android）**：纯只读消费公开快照与每日播客 Release。打开文章不会触发任何模型调用；只有在你主动提问或测连时，才向你自己的模型服务发送经确认的提取文字。

---

## 📱 Mac & Android 原生工作台（1.5.0）

![Mac 与 Android 音频研究工作台阅读、播客与个人资料同步边界](docs/images/client-experience.zh.svg)

| 能力维度 | 🌐 音频研究门户（Web） | 💻 macOS 音频研究工作台 | 📱 Android 音频研究工作台 |
|---|:---:|:---:|:---:|
| 9,300+ 篇精读、400 项九维分类与评分筛选 | ✅ 浏览器即开 | ✅ 离线快照 + 紧凑索引 | ✅ 离线快照 + 后台预热 |
| 导读与原始 PDF 同屏对照 / 物理页锚定 | 🔗 原文直达 | ✅ AppKit + PDFKit 双栏 | ✅ 手机单栏 / 平板并排 |
| 原生每日音频播客（章节跳转 / 0.75×–2.0×） | ✅ 网页播放器 | ✅ 离线 SHA 校验缓存 | ✅ 离线 SHA 校验缓存 |
| HTML5 / MathML / SVG 净化渲染 | ✅ Hugo KaTeX SSR | ✅ 严格白名单净化 | ✅ 严格白名单净化 |
| 个人研究追问（自配模型、账单完全隔离） | — | ✅ 仅发确认提取文字 | ✅ 仅发确认提取文字 |
| Zotero 文献归档（书目 + 导读 + PDF + 笔记） | 📥 BibTeX / RIS | ✅ 本机 Zotero API | ✅ 官方 Zotero Web API v3 |
| WebDAV 坚果云全空间版本备份与冲突合并 | — | ✅ 无损合并 + 密钥不离机 | ✅ 无损合并 + 密钥不离机 |

- **当前源码版本**：Mac 与 Android 均为 **1.5.0（构建号 24）**（新增原生每日音频播客播放器、离线检索筛选对齐、全量更名为“音频研究工作台”并兼容旧站点路径 `/audio-paper-digest-blog/`，详见 [1.5.0 审改记录](docs/workbench-1.5.0-review.md)）。
- **最近公开发行**：**1.4.7 / 构建号 23**（2026-11-23 发布，见 [GitHub Release v1.4.7](https://github.com/nanless/audio-research-workbench/releases/tag/v1.4.7) 与 [客户端发行核验](docs/client-release-verification.md)）。历史版本说明集中记录在 [docs/README.md](docs/README.md#阅读历史评审记录)。
- **升级提示**：从 1.4.x 升级到 1.5.0 时，macOS 应用包更名为 `音频研究工作台.app`，继续共用 `com.nanless.PaperDigest` 标识、原资料目录与钥匙串，安装后退出并移除旧包即可；macOS 包使用本地 ad-hoc 签名（未 Apple 公证，需 macOS 15+ Apple Silicon）。Android 保持 `com.nanless.paperdigest` 与 1.4.4+ 同签名证书，1.4.4+ 可直接覆盖升级，1.4.3 需先备份卸载再装。

---

<a id="默认行为"></a>
<a id="架构概览"></a>

## ⚙️ 一篇论文如何从 arXiv 走到可打开的网页

![音频研究日报端到端流水线：边界补抓、筛选、四文件封存、分析写作、三层审查与上线核验](docs/images/daily-digest-flow.zh.svg)

内容生产引擎默认采用 **LLM/API 管线**，覆盖三条独立流程：

| 流程 | 适用场景 | 来源封存与去重边界 | 权威指南 |
|---|---|---|---|
| **当天日更** | 每日追踪 arXiv 与 HuggingFace 音频新作 | 同步门户远端、仅按已发布页去重；入选后重拉官方 HTML + PDF 封存为四文件 | [日更步骤](SKILL.md#1-日更) · [补抓边界](docs/daily-fetch-boundary.md) |
| **官方会议整理** | 整批梳理 ICML / Interspeech / ICASSP 等顶会 | 绑定官方会议目录与 OpenReview / 会议 PDF 身份，独立去重与恢复 | [会议流程](docs/conference-workflow.md) |
| **历史博客更新** | 从原始论文重跑旧文章并严格保留原 URL | 固定历史页面集合与原路径映射，走独立发布凭证 | [历史更新](docs/history-rewrite.md) · [历史发布](docs/history-direct-publication.md) |

**四项底线设计保证了长期运行的稳定性与成本可控：**

1. **四文件来源封存**：筛选后、分析前为每篇论文封存 `source.txt`、`source.pdf`、`source-runtime.json`、`source-manifest.json` 及 SHA-256 摘要，后续写作、局部修复与复验只读这组冻结来源。
2. **按阶段分级推理 + 前缀缓存**：默认开启按阶段分级推理（`PD_TIERED_REASONING_EFFORT`）与稳定 `prompt_cache_key`——主分析与 Reader 长文使用 `xhigh`，审计与修复用 `high`，插图/结构补丁用 `medium`，筛选与文本审查用 `low`，机械标签/开源扫描用 `minimal`，把推理算力集中在真正需要深思的环节。
3. **等权账号池与严格留账**：同池多个 API Key 按 `paperId` 亲和哈希路由以抬升缓存命中；仅 429 配额上限或 401 余额不足才同请求换号并落盘冷却，普通 401 立即停产保护在途稿。每次请求的开始与终态按北京时间分片落账，绝不清零重算。
4. **三层审查与 SHA 永久复用**：生成后依次过规则核验、正文与原图审查、Hugo 实构建；已通过页面按“相对路径 + 内容 SHA”永久复用，重跑只审变动页，大幅节省时间与费用。

---

<a id="5-分钟开始"></a>
<a id="第一次使用"></a>

## 第一次使用

> 如果你只是阅读文章或使用 Mac / Android 客户端，**完全跳过这一节**——不需要克隆仓库，也不需要配置任何 API 密钥。

面向网站维护者与内容生产执行者的 4 步准备：

1. **核对工作区与角色**：进入 `$HOME/code/github_repos/audio-research-workbench`，核对 `pwd`，执行 `npm run workspace:role -- status` 确认角色为 `daily`（历史命令通过 `.env` 的 `PD_WORKSPACE_ALLOW_CROSS_ROLE=1` 跨角色执行）。
2. **准备运行时与环境**：按 [安装与配置](docs/setup.md) 准备好 Node（`>=20.18.1 <21 || >=22.3.0`）、Python 3.11+（`scripts/python-runtime.sh` 优先 `.venv`）与依赖；复制 `env.example` 为 `.env`，填写模型密钥、HTTP CONNECT 代理和本地 `audio-research-portal` Hugo 仓库路径。
3. **执行只读体检**：运行 `npm run doctor -- --offline` 与 `npm run config:check`。当前主/副模型统一配置为 `muse-spark-1.3-contributor`（推理上限 `xhigh`），arXiv 与 Muse 流量强制走项目 HTTP CONNECT 代理。
4. **确认无并发冲突**：确认当前没有其他生成、审查或推送任务在运行，且门户仓库目标日期没有未提交的人工改动。

所有不可绕过的执行限制以 [AGENTS.md](AGENTS.md) 为准，完整分步演练见 [新人上手](docs/onboarding.md) 与 [操作手册](SKILL.md)。

---

<a id="核心命令"></a>

## 选择任务

常用维护入口速查（运行前将示例日期、ID 与路径替换为当次真实参数）：

| 场景 | 命令与说明 |
|---|---|
| **当天日更** | `npm run digest:prepare -- YYYY-MM-DD`（`digest:api` 为等价别名）；见 [日更步骤](SKILL.md#1-日更) |
| **开跑前体检与探源** | `npm run doctor -- --offline`（加 `--network` 探 arXiv）、`npm run config:check`、`npm run source:probe -- --date YYYY-MM-DD`、`npm run llm:accounts` |
| **进度监控与效能记分卡** | `npm run digest:status -- --date YYYY-MM-DD --watch`、`npm run digest:scorecard -- --date YYYY-MM-DD` |
| **官方会议整理** | `conference:acquire` → `conference:discover` → 筛选 → `conference:process`；见 [会议流程](docs/conference-workflow.md) |
| **历史博客原文更新** | 固定范围后执行 `history:inputs` / `plan` / `sources` / `run` / `aggregate`；见 [历史更新](docs/history-rewrite.md) |
| **历史成果发布** | `npm run history:publication -- plan\|generate\|review\|publish\|status`；见 [历史发布](docs/history-direct-publication.md) |
| **已发布日批仅更新呈现** | `npm run blog:generate -- --date YYYY-MM-DD --republish UUID`，随后 `blog:review` → `blog:push` |
| **失败诊断与补丁清单** | `npm run recover -- --date YYYY-MM-DD`、`npm run manifest:new -- --spec SPEC.json` |
| **早批次抓取见证登记** | `npm run fetch:witness:prepare -- --date YYYY-MM-DD --source-date YYYY-MM-DD` |
| **表格预检、影响面与误报覆写** | `npm run table:check -- --draft FILE`、`npm run impact -- --git`、`npm run review:overrides -- --date DATE --file F.json` |
| **上线核验与收尾** | `npm run verify:web -- --date DATE --deploy OID`、`npm run publish:finish -- --date DATE` |
| **锁状态、文档与数据完整性** | `npm run locks`、`npm run docs:check`、`npm run validate:data` |
| **存储维护与账本压缩** | `npm run papers:compact`、`npm run storage:pdf-dedupe`、`npm run storage:report`、`npm run storage:prune` |
| **可选工具：分数校准 / 每日播客** | `npm run digest:calibrate -- --dry-run`、`npm run podcast:generate -- --date YYYY-MM-DD --dry-run` |
| **改动后全仓验收** | `npm run verify`（固定 Hugo 0.160.1 + 语法检查 + JS/Python 单测 + 数据校验） |

---

## 运行一次日更

把日期替换为**北京时间当天**：

```bash
npm run digest:prepare -- YYYY-MM-DD
```

程序将自动依次执行：同步门户远端 → 边界补抓并按已发布页去重 → 关键词预筛与模型筛选 → 封存每篇官方 HTML 与 PDF → 多阶段深度分析、评分、分类与 Reader 长文写作 → 生成门户页面并通过三层审查 → 精确差异推送并登记本次不生图。推送完成后，再确认 GitHub Pages 部署成功并执行逐页网页核验。

**三条硬边界请提前知晓：**

- **默认不生图**：按 2026-11-02 起的持续要求，日更不再生成论文长图与汇总封面（旧 `--no-visuals` 参数仍兼容），推送后自动登记不生图记录；论文原图照常拉取、展示和审查。登记异常见 [排障说明](docs/troubleshooting.md#11-不生图登记失败)。
- **历史日期不能从日更抓取阶段重跑**：新抓取严格绑定北京时间当天；历史日期仅可沿用受控来源从 `--from generate|review|push|visual` 续跑，或走历史更新流程（详见 [补抓边界](docs/daily-fetch-boundary.md)）。
- **只按已发布页去重**：此前落选或未发布的论文不会因进过候选列表而被跳过，后续仍可正常补更。

---

## 失败后从哪里继续

遇到单篇失败时，**先跑完本轮全部其余论文并落盘**，再仅对可重试失败集合续跑。所有已通过的来源、阶段检查点、草稿、历史计数和费用账本均完整保留，绝不推倒重来或清零记账。

| 中断位置 | 推荐恢复入口 |
|---|---|
| 日更分析或 Reader 长文 | `npm run deep`、`npm run batch` 或 `npm run api:reader:refresh`（自动只读同一组封存四文件） |
| 官方会议处理或页面维护 | 续跑原 `conference:process` / `conference:migrate-process`；详见 [会议恢复](docs/conference-workflow.md#已有完整会议只更新页面) |
| 历史准备或分析 | 继续原计划与 `npm run history:run`；暂停任务用 `npm run history:resume` 恢复 |
| 博客正文或图片审查拒稿 | 先跑完整批审查；正文走正常 Reader 维护，图片可先派发同篇认证 PDF 出版视图后重审 |
| 认证、余额、配置或保存异常 | 立即停止新派发、保全在途稿并排除故障（多号池逐号独立探测），修复后从原阶段续跑 |

多轮自动恢复后若仅剩极少数顽固项，可使用来源绑定的受控人工修正清单（每篇限定 1–8 个已有节点，修正后仍须通过完整资格与博客审查，详见 [解读恢复](docs/reader-explicit-retry.md)）。有助于提升效率与成稿质量的必要后续付费窗口已获 [持续授权](AGENTS.md#持续授权以效率和效果为准)，按实际进度单独记账即可。

> **旧链退役说明**：整批 Manual 写作与微信、飞书、小红书发布已退役。[manual/README.md](manual/README.md) 仅保留旧记录核验及独立人工审查（新独立审查使用 `gpt-6.1-sol/high` 并登记真实身份）。

---

## 怎样才算完成

一次日更必须同时满足 [AGENTS.md 的六项完成标准](AGENTS.md#日更完成的六项)才可宣告上线：

1. **数据与来源**：正式分析、封存来源、Reader 长文、八维评分与九维标签通过当前检查。
2. **审查**：最终页面通过规则、正文、原图及 Hugo 实构建审查，审查凭证覆盖完整目标集合。
3. **远端发布**：仅推送凭证允许的精确差异，并核对远端 `main` 提交 OID 一致。
4. **部署**：对应发布提交（或保留本批已审字节的后续提交）的 GitHub Pages `build` 与 `deploy` 均成功。
5. **网页核验**：逐页核验汇总页与单篇的 HTTP 200、正式地址与准确标题（`npm run verify:web`），并保存核验记录。
6. **不生图登记与重读状态**：与当前发布绑定的不生图记录有效，最后重跑 `npm run digest:status -- --date YYYY-MM-DD` 复核。

`digest:status` 只反映读取瞬间的本地与发布快照，不能替代第 4、5 项的真实部署与在线网页核验。

---

## 📁 仓库结构一览

```text
audio-research-workbench/
├── scripts/               # 内容生产核心引擎（抓取、筛选、封存、分析、评分、Reader、审查、推送、播客）
│   └── lib/               # 公共库：LLM 路由/缓存/账号池、来源验证、SVG/PDF 处理、锁与成本账本
├── prompts/current/       # 现行阶段提示词模板（附历史 Git blob 指纹冷重放索引）
├── config/                # 400 项九维分类词表、协议目录（clients*.json）、工作区角色与历史见证
├── apps/
│   ├── macos/             # macOS 原生音频研究工作台（Swift / AppKit / WebKit / PDFKit）
│   └── android/           # Android 原生音频研究工作台（Kotlin / Jetpack Compose / Room）
├── docs/                  # 架构、数据合同、操作指南、客户端验收与双语示意图（docs/images/）
├── skills/                # 可复用的清晰技术写作与工程操作 Skill
├── manual/                # 已退役整批 Manual 的只读历史核验与单篇独立人工审查入口
└── tests/                 # Node.js + Python 自动化回归测试套件（含离线契约与冷重放测试）
```

---

## 文档导航

- 🗺️ **[项目导读](docs/project-guide.md)**：10 分钟看懂论文来源、分析引擎、音频研究门户与双端客户端的关系。
- 📖 **[操作手册](SKILL.md)** 与 **[执行规则 AGENTS.md](AGENTS.md)**：按步骤操作指南、失败恢复与不可绕过的约束红线。
- 📚 **[文档总索引](docs/README.md)**：按任务快速定位环境配置、来源边界、九维分类、云备份、性能与故障排查。
- 🔧 **[脚本指南](scripts/README.md)** 与 **[完整脚本索引](scripts/INDEX.md)**：查阅每个 CLI 入口、共享核心库与兼容模块。
- 🔐 **[客户端发行核验](docs/client-release-verification.md)**：Mac 与 Android 安装包签名、证书、12 件附件与 SHA-256 核验记录。
- ✍️ **[把技术写清楚](skills/clear-technical-writing/SKILL.md)** 与 **[项目写作约定](docs/writing-guide.md)**：面向初学者的清晰写作、术语统一与配图规范。
