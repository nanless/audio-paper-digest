# 新人上手：执行顺序、状态文件与故障入口

这份说明帮助第一次维护论文速递的人完成一次当天日更，并找到结果与失败记录。如果你只想阅读网站或使用工作台，先读[项目导读](project-guide.md)，无需配置生产项目。

## 1. 运行当天日更

### 先确认环境和任务范围

按[安装配置](setup.md)准备工作区、依赖、模型、代理和博客仓库。展开并核对实际目录，确认工作区角色为 `daily`；不要在废弃目录运行任务。正式开始前还要确认没有其他任务同时生成、审查或推送博客，目标页面没有人工修改冲突。

只读体检用于发现缺失配置，不会调用模型。它允许诊断尚未通过角色检查的环境，但不放行正式任务，也不绕过外部运行环境检查。

```bash
npm run doctor -- --offline
```

体检通过后，把日期替换为北京时间当天，再执行：

```bash
npm run digest:prepare -- YYYY-MM-DD
```

`digest:api` 与 `digest:prepare` 等价。这个入口会抓取来源、调用模型、保存结果，并继续生成、审查和推送博客；它不只是下载论文的命令。历史日期不能从抓取阶段开始，已有任务按原来源与阶段恢复。

### 了解程序正在做什么

```text
抓取 arXiv/HuggingFace 候选，去除已经正式发布的论文
  → 筛选 → 保存本次官方正文、PDF 与来源记录
  → 分析 → 评分与标签 → 撰写解读长文
  → 生成博客 → 审查 → 推送
  → 登记与本次发布绑定的不生图记录
```

程序中把面向读者的解读长文称为 Reader。内部主分析、解读长文和来源记录分别保存、分别核对；有一份旧成功正文，不表示最新纠错已经完成。

运行中用下面的只读轻量查询观察阶段、数量、失败与费用：

```bash
npm run digest:status -- --date YYYY-MM-DD --watch
```

它默认每 10 秒刷新，不完整核验发布豁免。最终确认时去掉 `--watch`，读取普通完整状态，不把轻量进度当作发布证明。

`doctor --offline` 不联网。如果需要检查来源服务是否可用，可执行 `npm run source:probe -- --date DATE`。它会探测 arXiv 的 Atom、官方 OAI 和 RSS，不写抓取数据，也不调用模型。探测通过只说明入口状态，正式抓取仍须核对完整来源窗口。

### 推送后继续核验网页

1. 确认对应提交的 GitHub Pages 构建和部署成功。
2. 核验全部目标页面的正式地址、HTTP 200 和准确标题；工具的有限检查不能替代实际要求，见[网页核验说明](maintenance.md#发布后网页核验与收尾)。
3. 确认本次发布的不生图记录有效。日更默认不生图，论文原图仍正常展示与审查；只有用户另行明确改变要求，才执行对应图片任务。
4. 重新读取 `npm run digest:status -- --date YYYY-MM-DD`。

Git 推送、站点部署和网页可读是不同结果。只有它们都核验通过，并保存相应记录，才能报告日更已经完成。

## 2. 状态文件地图

来源、付费响应、原失败和费用都属于恢复依据。不要手动删除失败或重置次数来继续任务；正常入口会检查文件内容与本次输入之间的对应关系。

| 文件或目录 | 由谁写入 | 保存什么 |
|---|---|---|
| `data/current/deep-analysis-result.json` | 分析与恢复入口 | 正式结果、失败、来源和各阶段记录 |
| `data/current/blog-generation-manifest-<date>.json` | `blog:generate` | 本次生成的页面与资产清单 |
| `data/current/blog-review-passes-<date>.json` | `blog:review` | 与路径及内容 SHA 绑定的已通过页面缓存 |
| `data/current/blog-review-failure-<date>.json` | `blog:review` | 本次未通过页面与具体问题 |
| `data/current/blog-review-receipt-<date>.json` | `blog:review` | 本次审查凭证；推送只提交它允许的差异，不生图登记也绑定它的完整 SHA |
| `data/current/blog-republications/<date>.json` | `blog:generate --republish` | 重发布日期标记；事务待激活时会阻断普通生成、审查和推送 |
| `data/runtime/analysis-batch-reports/` | 分析与恢复入口 | 批次轮次、当前失败集合和 `manualHandoff` 报告 |
| `data/current/web-verification-<date>.json` | `verify:web` | 部署状态与逐页 HTTP 200、正式地址、标题的核验记录 |
| `data/runtime/llm-account-pool.json` | Node/Python 账号池 | 轮转游标和冷却状态，权限 `0600` |
| `data/runtime/llm-usage/` | 公共请求封装 | 请求开始、终态和实际用量；费用未知时保留未知 |
| `logs/summaries/<date>-summary.log` | Node/Python 入口 | 本次各阶段的摘要 |

这里的 SHA 是按内容计算的指纹，帮助发现文件变化；它不证明正文科学正确。清单和凭证还会核对真实来源、论文身份、处理范围和阶段结果，详见[数据格式](data-format.md)。

## 3. 按故障选择下一步

### 当天候选为 0

抓取正常、但当天没有可筛选的新论文时，程序在付费筛选前停下，并在 `raw-candidates.json` 写入 `stats.zeroCandidates: true`。确认当天确实没有新论文后，才在抓取阶段重跑并显式放行：

```bash
npm run digest:prepare -- YYYY-MM-DD --allow-empty-daily
```

放行后只生成“今日没有新论文”的汇总页，没有单篇页和论文图；该参数只对抓取阶段有效，其他阶段传入会直接报错。详见[抓取边界](daily-fetch-boundary.md)。

### 来源服务限流或公告未更新

先用 `npm run source:probe -- --date DATE` 检查真实入口，再按[抓取边界](daily-fetch-boundary.md)决定等待或恢复。

官方 OAI 恢复只接受已经核验的特定失败链：Atom 日期查询与分类前缀查询均为 HTTP 429，或原 OAI 失败的受控延续。单独的 5xx、过期 RSS 不满足条件；OAI 也不能替代尚未生成的目标日公告。

### 模型认证、额度或冷却问题

停止生产新派发，保存在途结果。用 `npm run llm:accounts` 核对账号状态，再按[模型排障](troubleshooting.md#2-主模型请求失败超时或空响应)处理。普通认证 401 和 arXiv 来源限流需要分别诊断，不能因为一项失败就换掉所有配置。

### 分析、解读长文或表格未通过

先完成本轮全部论文并保存结果，再用 `npm run recover -- --date DATE` 查看已保存的问题与建议，按[恢复说明](reader-explicit-retry.md)选择入口。建议本身不授予重试次数，正式执行仍核对真实来源、完整失败集合和预算。

少量既有节点的人工修正，先用 `npm run manifest:new -- --spec SPEC.json` 预览清单。材料准备与正式保存为结果分开；原稿、来源、节点范围与付费历史仍按[人工修正规则](reader-explicit-retry.md#少量顽固稿的来源绑定人工修正)核对。

### 博客审查失败

先完成整批审查，再看失败文件。正文问题交回生成或正常解读维护；图片仍按来源与实际像素核对。`review:overrides` 只核对误报解释，不修改真实审查结果，也不代替正式审查与发布。

### 推送前核对差异

`npm run blog:push -- --date DATE --dry-run` 只预览，不推送。它会拒绝审查清单外的改动，也不证明正式推送已经获准或远端已经验证。

发现其他改动时先核对归属，保留无关工作，再按正常凭证与精确差异规则推送。不要为了通过预览而清除别人的修改。

### 推送后的部署与网页

用 `npm run verify:web -- --date DATE --deploy OID` 检查本次发布。`npm run publish:finish -- --date DATE` 仅打印后续清单，执行者仍须按清单完成真实检查。

已有任务的持续付费授权覆盖必要后续窗口，无需逐轮重新询问；每个窗口仍保留真实来源、限额、旧次数和全部费用。日更不生图同样已获持续授权，但登记仍须绑定当前发布。完整执行限制见[操作手册](../SKILL.md)和[AGENTS.md](../AGENTS.md)。
