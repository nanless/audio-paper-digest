# 新人上手：执行顺序、状态文件与故障入口

## 1. 运行当天日更

先按[安装配置](setup.md)准备工作区、依赖、模型、代理和博客仓库，再将日期替换为北京时间当天：

```bash
npm run doctor -- --offline
npm run digest:prepare -- YYYY-MM-DD
```

脚本执行的阶段：

```text
抓取 arXiv/HuggingFace → 筛选 → 封存官方来源
  → 分析、Reader、评分与标签 → 生成博客 → 审查 → 推送
  → 准备视觉输入；用户已明确取消视觉时登记本次发布的豁免
```

推送后，由执行者继续完成：

1. 确认对应提交的 GitHub Pages 构建和部署成功。
2. 核验全部目标页面的正式地址、HTTP 200 和标题。
3. 使用内置 `image_gen` 生成所需长图及封面，逐图检查后登记；已明确取消视觉且豁免有效时省略此步。
4. 重新读取 `npm run digest:status -- --date YYYY-MM-DD`。

运行中可用 `npm run digest:status -- --date DATE --watch` 观察进度。`doctor --offline` 不联网；`npm run source:probe -- --date DATE` 会联网探测 arXiv 的 Atom、官方 OAI 和 RSS，不写抓取数据或调用模型。`digest:api` 与 `digest:prepare` 等价。

## 2. 状态文件地图

| 文件或目录 | 写入入口 | 保存内容 |
|---|---|---|
| `data/current/deep-analysis-result.json` | 分析与恢复 | 正式结果、失败、来源和阶段记录 |
| `data/current/blog-generation-manifest-<date>.json` | `blog:generate` | 页面及资产清单 |
| `data/current/blog-review-passes-<date>.json` | `blog:review` | 与路径、内容 SHA 绑定的通过缓存 |
| `data/current/blog-review-failure-<date>.json` | `blog:review` | 审查失败集合与逐项问题 |
| `data/runtime/llm-account-pool.json` | Node/Python 账号池 | 轮转游标和冷却状态，权限 `0600` |
| `data/runtime/llm-usage/` | 请求封装 | 请求开始、终态和实际用量；未知费用保持未知 |
| `logs/summaries/<date>-summary.log` | Node/Python 入口 | 阶段摘要 |

原来源、付费响应、失败和费用必须保留。状态文件与输入的对应关系由正常入口重新核验。

## 3. 按故障选择下一步

| 问题 | 处理顺序 |
|---|---|
| arXiv 限流、5xx 或公告未更新 | 先 `npm run source:probe -- --date DATE`，再按真实来源诊断等待或恢复。官方 OAI 恢复要求 Atom 日期查询及分类前缀查询均为 HTTP 429 的已核验失败链，或原 OAI 失败的受控延续；单独的 5xx、过期 RSS 不满足条件。见[抓取边界](daily-fetch-boundary.md)。 |
| 模型认证、账号额度或冷却 | 停止生产新派发，保存在途结果；用 `npm run llm:accounts` 核对状态，再按[模型排障](troubleshooting.md#2-主模型请求失败超时或空响应)处理。普通 401 与 arXiv 限流分别诊断。 |
| 分析、Reader 或表格问题 | 完成本轮并保存结果，再用 `npm run recover -- --date DATE` 查看已保存问题及建议，按[恢复说明](reader-explicit-retry.md)选择正常入口。工具建议仍须经过来源、完整失败集合和预算核验。 |
| 已授权的少量节点人工修正 | `npm run manifest:new -- --spec SPEC.json` 先预览；准备材料与正式采纳分开，原稿、来源、节点范围及付费历史按[人工修正规则](reader-explicit-retry.md#少量顽固稿的来源绑定人工修正)核验。 |
| 博客审查失败 | 先完成整批审查，查看失败文件，回到生成或正常 Reader 维护。`review:overrides` 只核对误报解释，正式审查与发布继续核验。 |
| 推送前核对差异 | `npm run blog:push -- --date DATE --dry-run`；核对后用同命令去掉 `--dry-run` 正常推送。 |
| 推送后部署与网页 | `npm run verify:web -- --date DATE --deploy OID`。`npm run publish:finish -- --date DATE` 仅打印后续清单，执行者按清单继续。 |

任务已有持续付费授权时，执行者登记必要后续窗口，无需逐轮重新询问；每个窗口保留真实来源、限额、旧次数和全部费用。视觉豁免须有用户明确授权并绑定当前发布。完整要求见[操作手册](../SKILL.md)和[执行约束](../AGENTS.md)。
