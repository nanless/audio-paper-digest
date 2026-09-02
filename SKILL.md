# Audio Paper Digest 操作手册

## 1. 受众、目标与入口

本文给需要运行、恢复、发布或维护默认 LLM/API 论文速递的 Agent。紧凑强约束见 [AGENTS.md](AGENTS.md)，文档地图见 [docs/README.md](docs/README.md)，脚本地图见 [scripts/README.md](scripts/README.md)。

默认目标是把一个北京时间批次完整推进到远端博客和发布后视觉终态：

```bash
npm run digest:prepare -- YYYY-MM-DD
# 完全等价
npm run digest:api -- YYYY-MM-DD
```

`full-fetch.js` 只是数据阶段；“运行某日论文速递”要求继续 generate、review、push、内置生图和最终验收。其他渠道不在默认范围。

显式 Manual 是隔离子系统，只在用户明确点名时进入：

```bash
npm run digest:manual -- YYYY-MM-DD
```

进入前完整阅读 [manual/README.md](manual/README.md)。默认 API 失败不得改写为 Manual 成功。

## 2. 第一次运行

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp env.example .env
```

在 `.env` 至少配置：

```dotenv
PAPER_ANALYZER_API_KEY=your-key
PAPER_ANALYZER_MODEL=muse-spark-1.2-contributor
PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
PAPER_DIGEST_BLOG_REPO=/absolute/path/to/audio-paper-digest-blog
```

Node 要求 `>=20.18.1 <21 || >=22.3.0`。默认发布入口要求 Python 3.11+ 且由 OpenSSL 提供 TLS；`scripts/python-runtime.sh` 依次选择项目 `.venv`、`python3.11`，最后才校验 `python3`。项目脚本必须沙箱外执行；沙箱拒绝不是远端服务故障。

## 3. 默认流程概览

```text
归档 current
  → arXiv + HuggingFace 代理抓取
  → 博客已发布去重
  → 高召回关键词预筛
  → LLM 逐篇筛选
  → 多阶段全文分析
  → 类型感知评分审计
  → API Reader v3 长文、source-binding v4 与官方 Figure 闭环
  → generate
  → review
  → push + 远端 OID
  → TOP 10 长图 + 汇总封面
  → digest:status
```

### 3.1 抓取与候选闭环

`scripts/full-fetch.js` 先按日期归档 current，再抓取 7 个 arXiv 类别与 HuggingFace Papers。抓取不是“尽力而为”：每个必需来源必须有完整 checkpoint、候选数量与稳定内容 SHA。arXiv/HF 均强制项目代理。

`raw-candidates.json` 保存合并且博客去重后的全集。关键词预筛只对摘要完整且明显未命中音频词族的补充类别形成确定性否定；核心类别、短摘要和词族命中项必须进入 LLM。筛选结果只有在 `filter-decisions.json` 完整覆盖 raw，且 `filtered-papers.json` 精确等于相关决定减去显式排除时才 complete。

### 3.2 全文分析与 Reader

每篇论文先获取健康 arXiv HTML，失败时受控回退 PDF；结构不足、错误页和摘要壳不能冒充全文。来源 SHA 变化会失效主分析及下游。

默认阶段包括：主分析、开源扫描、Demo 扫描、审校、表格/方法/结构修复、评分审计、API Reader 和 Figure 物化。各阶段绑定输入、模型、协议、Prompt、温度、预算和输出 SHA；变化只重跑当前阶段及下游。

主分析 canonical 保留 13 个固定中文一级标题供机器解析。真正发布给读者的是 `beginner-researcher-v3`：

- 12–18 个按学习依赖递进的小节；
- 5000–18000 中文字；
- 4–10 组术语组合桥；
- 数据/协议、主结果、消融/失败、训练或部署成本等叙事表；
- 官方 Figure 的“导读—看图路径—原图—图注—解释”相邻闭环；
- Markdown 表逐格绑定原表 DOM cell 或逐字原文 quote，展示公式由结构化原始 TeX 确定性注入；
- 作者机构逐项重放来源；开源资源逐项绑定原文或已验证 Demo、重定向终点与可达状态，暂时不可达不得冒充可用；
- 初学研究者能分清论文事实、有限解释和未验证推测。

### 3.3 评分

评分八维为：创新性 2、技术严谨性 1.5、实验充分性 1.5、清晰度 1、影响力 1.5、开源 1.5、可复现性 0.5、工程/实践价值 1.5。分项总和最大 11，发布总分由代码重算并封顶 10。

文档类型决定适用证据，不改变权重。一个缺陷只归一个主要维度：产物缺失归开源，配置缺失归可复现性，支撑声明的实验不足归实验充分性，表达问题归清晰度，真实逻辑/推导错误才归技术严谨性。评分审计必须引用证据账本，并记录 `evidenceProfile` 与代码上限。

## 4. API、代理、并发和上下文

### 4.1 协议路由

| 优先条件 | 协议 | URL |
|---|---|---|
| DeepSeek 域名或模型 | OpenAI Chat | `/v1/chat/completions` |
| 精确 Muse Contributor | OpenAI Responses | `/v1/responses` |
| `token-plan` + MiMo | Anthropic | `/anthropic/v1/messages` |
| Kimi coding | Anthropic | `/coding/v1/messages` |
| 其他 `/anthropic` | Anthropic | `{base}/messages` |
| 其他 | OpenAI Chat | `/v1/chat/completions` |

所有 Node LLM 调用经 `requestLlmJson()`。Muse 每次使用独立 HTTP CONNECT agent；其他模型默认 `agent:false`。Python 发布使用同一 Muse 例外。

### 4.2 默认预算

| 参数 | 默认 |
|---|---:|
| `PD_ANALYSIS_CONCURRENCY` | 3 |
| `PD_ANALYSIS_MAX_RETRIES` | 2 |
| `PD_ANALYSIS_API_MAX_RETRIES` | 3 |
| `PD_ANALYSIS_API_MAX_TOKENS` | 64000 |
| `PD_ANALYSIS_API_MAX_RESPONSE_BYTES` | 16777216（16 MiB） |
| `PD_ANALYSIS_REPAIR_MAX_TOKENS` | 16000 |
| `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` | 200000 |
| `PD_API_READER_MAX_TOKENS` | 48000 |
| `PD_API_READER_EVIDENCE_MAX_CHARS` | 180000 |
| `PD_API_READER_CONTEXT_MAX_CHARS` | 240000 |
| `PD_API_READER_CONCURRENCY` | 5，限制 1–5 |
| `PD_BLOG_REVIEW_CONCURRENCY` | 5，限制 1–5 |

Muse 筛选实际 batch 固定为 1；整篇分析仍按配置并发，因为每个请求有独立隧道。Responses 仅在 `PD_OPENAI_RESPONSES_STREAM=1` 时 SSE。返回 `incomplete/max_output_tokens` 时不得接受半截 JSON。

## 5. 权威数据与恢复

### 5.1 current 文件

| 文件 | 含义 |
|---|---|
| `papers.json` | 永不按日移走的去重库与 digest 状态 |
| `fetch-checkpoint.json` | 每个抓取来源的恢复证明 |
| `raw-candidates.json` | 筛选全集 |
| `filter-decisions.json` | 逐篇筛选决定与缓存 |
| `filtered-papers.json` | 正式入选集 |
| `deep-analysis-result.json` | canonical、checkpoint 与 production proof |
| `blog-generation-manifest-*.json` | 生成页面集合和 SHA |
| `blog-review-receipt-*.json` | review、Git 基线、远端发布证明 |
| `visual-summary-manifests/*.json` | TOP 10 长图任务 |
| `digest-cover-manifests/*.json` | 汇总封面任务 |

`data/archive/<date>/` 是日期快照，不是自动可信的 current 替代。历史状态只有在跨文件日期、候选、决定和论文集合全部闭合时可用。

### 5.2 恢复命令

```bash
# 同日完整续跑
npm run digest:prepare -- YYYY-MM-DD

# 从指定编排阶段恢复
./run-daily-digest.sh YYYY-MM-DD --from review

# 只续分析
npm run deep -- --date YYYY-MM-DD

# 强制重分析
npm run reanalyze -- --concurrency 5

# 批量刷新评分与 Reader
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader

# 只读数据验证与最终状态
npm run validate:data
npm run digest:status -- --date YYYY-MM-DD
```

从 fetch 开始的日期必须是北京时间当天。历史批次只从脚本允许的安全阶段续跑。不要手改 checkpoint 伪造完成态。

## 6. 博客发布事务

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

generate 安装精确页面并签发 generation manifest；review 对不可变页面 artifact 做确定性、LLM、图片和 Hugo 审查，逐页 checkpoint，最后签发 receipt；push 只允许 receipt 描述的 Git delta，提交后验证远端 `main` OID。

以下任一变化都必须阻断或重建凭证：页面字节、generation、production proof、review 协议、Hugo gate、博客基线、remote 名称或 push URL 身份。review 不修改已审页面；修复回到生成阶段。

单篇 `--include-id`、排除 `--exclude-id` 和历史 sealed preview 是显式维护功能，参数必须在三阶段保持一致；不要把单篇事务当成整批发布或视觉依据。

## 7. 发布后视觉

远端 OID 验证后，`push-blog.py` 规划 TOP 10 论文长图和一张汇总封面。项目脚本只管理 manifest、参考缓存和状态，实际绘图只能由 Codex 内置 `image_gen` 完成。

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

`visual:prepare` 复验 `.bin` 缓存并输出真实扩展名的绝对路径。登记前逐图检查标题、中文、结构关系、指标方向、数字与排行榜；`record` 必须带 `--qa-attested true`。用户明确说不生图时，使用 `digest:waive-visuals` 签发绑定当前 publication 与 manifest 的 waiver，不能把 pending 改成 complete。

## 8. 维护与验证

```bash
npm test
npm run validate:data -- --allow-empty
```

- 新分析入口复用 `analysis-engine.js`，新 LLM 调用复用公共路由和请求封装。
- Node/Python 路径进入集中配置；写 JSON 使用原子写和跨进程锁。
- Prompt 第一个 fenced block 是运行时正文；修改结构化输出时同步解析器、validator、测试和指纹。
- 日志使用毫秒级北京时间、`0600` 权限并脱敏；不得记录密钥、认证头、Cookie 或 URL userinfo。
- `data/`、`logs/`、`.env`、缓存和运行产物不得提交。
- Git 提交信息用具体中文说明原因、范围和影响。
- 诊断、命令和字段细节按 [docs/README.md](docs/README.md) 路由，不在本文件复制 Manual 或渠道内部协议。
