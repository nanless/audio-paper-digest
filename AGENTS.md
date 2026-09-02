# AGENTS.md

## 这份文件给谁

给第一次进入仓库、需要运行或修改论文速递的 Agent。它只保留不看代码最容易遗漏的强约束；完整操作说明见 [SKILL.md](SKILL.md)，按任务查文档见 [docs/README.md](docs/README.md)，代码入口见 [scripts/README.md](scripts/README.md)。

## 默认目标与最短路径

用户说“运行/进行 YYYY-MM-DD 论文速递”时，默认且唯一隐含路线是完整 LLM/API 日更：

```bash
npm run digest:prepare -- YYYY-MM-DD
# digest:api 是完全等价的显式别名
```

这项请求已经授权：联网抓取 → 关键词预筛 → LLM 筛选 → 多阶段全文分析与评分 → API Reader 初学研究者长文 → 博客 generate → review → push 与远端 OID 验证 → 发布后视觉任务 → 最终状态验收。不要在分析、review 或 push 后提前结束，也不要再次询问是否发布博客。

只有用户明确说“Manual/人工流程”时才运行 `npm run digest:manual -- YYYY-MM-DD`。进入前完整阅读 [manual/README.md](manual/README.md)；API、网络或配额失败绝不自动切换 Manual。微信、飞书、小红书不属于默认日更。

## 运行前五项检查

1. Node 满足 `>=20.18.1 <21 || >=22.3.0`，依赖已安装。
2. 项目根 `.env` 存在，权限由 loader 收紧为 `0600`。
3. `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT` 完整；默认文档配置是 OpenCode Go `muse-spark-1.2-contributor`。
4. `HTTPS_PROXY` 或 `HTTP_PROXY` 是项目 `.env` 内的 HTTP CONNECT 地址；Muse 与 arXiv 缺代理立即失败。
5. `PAPER_DIGEST_BLOG_REPO` 指向真实 Hugo 仓库，工作区没有与目标日期重叠的人工修改。

所有项目脚本、测试、语法检查和数据校验必须在沙箱外执行。脚本会在业务逻辑、日志、网络和写入前拒绝可靠的 `CODEX_SANDBOX` 标志；不得绕过或伪造结果。

## 权威来源

| 问题 | 权威来源 |
|---|---|
| npm 命令是否存在 | `package.json.scripts` |
| Node 参数与 current 路径 | `scripts/config.js` |
| Python 发布路径 | `scripts/path_config.py` |
| 环境隔离 | `scripts/env-loader.js`、`scripts/project_env.py` |
| API 路由与 Node 请求 | `scripts/utils.js` |
| 发布 LLM 请求 | `scripts/publish_common.py` |
| 默认 API 脚本职责 | [scripts/README.md](scripts/README.md) |
| Manual 协议 | [manual/README.md](manual/README.md) |

文档与实现冲突时，先按当前 fail-closed 实现处理，再在同一变更中修正文档。

## 默认 API 数据链

`scripts/full-fetch.js` 负责归档、博客去重、arXiv/HuggingFace 抓取、筛选、论文库更新、深度分析和逐篇持久化。关键状态位于 `data/current/`：

- `papers.json`：跨运行累积的去重库，永不随日批次移走。
- `fetch-checkpoint.json`：逐来源候选数量与内容 SHA。
- `raw-candidates.json`：当日完整候选。
- `filter-decisions.json`：逐篇筛选决定、理由、响应和输入指纹。
- `filtered-papers.json`：当日正式入选集合。
- `deep-analysis-result.json`：canonical 分析、逐阶段 checkpoint 和 production proof。

完整性不是“文件存在”：raw、decision、filtered、deep 的日期、来源、候选指纹和论文集合必须闭合。运行 `npm run validate:data` 做只读验证；干净 checkout 才可显式加 `--allow-empty`。

## 模型、代理、并发与预算

默认 Muse 精确模型走 OpenAI Responses，`/v1` 转为 `/v1/responses`。所有 Node LLM 请求必须经 `requestLlmJson()`；Python 发布请求必须经 `call_publish_llm_api()`。

- Muse：强制项目 HTTP CONNECT，一次请求一个 one-shot agent，请求后销毁，禁止静默直连。
- 其他 LLM：默认 `agent:false` 直连，避免继承代理污染 MiMo/Kimi。
- arXiv 元数据、HTML、PDF、图片：强制项目 HTTP CONNECT。
- HuggingFace curl：继承 HTTP(S) 代理，可额外使用 `ALL_PROXY` SOCKS。
- 外部图片/Demo：仅 HTTPS；逐跳拒绝私网/保留地址并固定已校验公网 IP，防止 DNS 重绑定。

| 能力 | 默认值 | 覆写 |
|---|---:|---|
| 整篇分析并发 | 3 | `PD_ANALYSIS_CONCURRENCY` |
| 筛选配置批次 | 5；Muse 实际固定 1 | `PD_FILTER_BATCH_SIZE` |
| 整篇重试 / 单阶段尝试 | 2 / 3 | `PD_ANALYSIS_MAX_RETRIES` / `PD_ANALYSIS_API_MAX_RETRIES` |
| 主分析 / 局部修复输出 | 64000 / 16000 tokens | `PD_ANALYSIS_API_MAX_TOKENS` / `PD_ANALYSIS_REPAIR_MAX_TOKENS` |
| API Reader 输出 | 48000 tokens | `PD_API_READER_MAX_TOKENS` |
| Reader 证据 / 总上下文 | 180000 / 240000 字符 | 对应 `PD_API_READER_*_MAX_CHARS` |
| Reader 重阶段并发 | 5，范围 1–5 | `PD_API_READER_CONCURRENCY` |
| 独立博客页 review 并发 | 5，范围 1–5 | `PD_BLOG_REVIEW_CONCURRENCY` |

主分析最多使用 200000 字符并跨全文均衡取样；后处理只接收任务相关证据。预算和证据选择版本进入阶段指纹。OpenAI Responses 只有 `PD_OPENAI_RESPONSES_STREAM=1` 时启用 SSE；`incomplete/max_output_tokens` 必须记为截断失败，不得接受半截 JSON。

## 恢复原则

- 普通续跑：重新运行同一入口；checkpoint 指纹决定从哪个阶段继续。
- 只续深度分析：`npm run deep -- --date YYYY-MM-DD`。
- 强制全量重分析：`npm run reanalyze -- --concurrency N`。
- 刷新 Reader/评分：`npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader`。
- 历史日期不能从 fetch 开始；只可从已有安全阶段运行 `./run-daily-digest.sh DATE --from generate|review|push|visual` 等代码允许的阶段。
- 失败记录必须保留 `analysisManifest`、checkpoint 和恢复图片清单。旧成功正文可保留，但最新失败必须强制后续重试；成功后才清除失败标记。
- 同篇分析必须持有规范化 arXiv ID 锁，并在锁内重读、合并、递增 generation，禁止用锁外陈旧对象覆盖 canonical。

## 内容与评分门禁

默认 API canonical 的 13 个一级标题是解析锚点；最终博客正文来自 `beginner-researcher-v3` API Reader：

- 12–18 节、5000–18000 中文字、4–10 组术语桥。
- 术语首次白话解释；组合机制必须说明分工、搭配原因和新增作用。
- 表格必须与前后论证闭环，原文证据充足时覆盖数据协议、主结果、消融/失败条件和训练/部署成本。
- Figure 必须形成“导读 → 看图路径 → 原图 → 图注 → 解释”；未传入像素不得猜坐标轴、曲线、颜色或模块。
- 评分使用八维、类型感知、单一缺陷单一主维度原则；代码重算总分并封顶 10。缺失证据不得写成技术错误。
- 摘要级分析默认不可发布；只有显式 `allowAbstractAnalysisPublish: true` 才允许并显示降级提示。

## 博客三阶段与远端证明

严格顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

generate 只生成并签发 schema v3 generation manifest；review 只读审查最终字节并绑定逐页 SHA、协议、Git 基线和 Hugo gate；push 只提交 receipt 精确允许的 delta，推送后验证远端 `main` OID。任何页面字节、generation、协议、基线或 remote 身份漂移都必须失败关闭。review worker 不得原地修改已审字节；修正建议返回生成/修复阶段。

## 发布后视觉与完成定义

push 远端验证后才可规划视觉任务。TOP 10 论文各一张长图，另有一张汇总封面；实际生成只能由 Codex 内置 `image_gen` 完成，项目脚本不得调用图像 API。

调用生图前运行 `npm run visual:prepare -- --date DATE`，只把输出的绝对 `referencedImagePaths` 交给工具。逐图目检标题、中文、箭头、指标方向、数字和排行榜后，才可用对应 `record --qa-attested true` 登记。最终重新运行：

```bash
npm run digest:status -- --date YYYY-MM-DD
```

只有数据、review、远端发布、论文视觉和封面全部 complete，或用户明确签发仍有效的视觉 waiver，整批才完成。状态报告是读取时快照；任何后续 push/record 后必须重跑。

## 修改与验证

- 文件编辑使用可恢复方式，保留用户无关改动；禁止未授权 `git reset --hard`、强推或批量删除。
- Prompt 的第一个 fenced block 是 `loadPrompt()` 实际读取内容；修改后检查占位符、解析器、SHA 和阶段指纹。
- 新 LLM 调用复用公共路由/请求封装；新分析入口复用 `analysis-engine.js`；新路径进入集中配置。
- CI 运行 `npm test`、`npm run validate:data -- --allow-empty`、默认与 Manual JS/Python 检查及全仓 shell 语法检查。
- 提交信息使用具体中文，说明原因、范围与影响；提交前确认 `data/`、`logs/`、`.env`、缓存和密钥未被跟踪。
