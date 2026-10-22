# 新人上手：三张图与常见故障入口

## 1. 一条命令的流程

```
npm run digest:prepare -- YYYY-MM-DD
  → 抓取(arXiv/HF) → 筛选 → 封存四源 → 多阶段分析+Reader → 评分/标签
  → blog:generate → blog:review → blog:push → 部署/网页核验 → 视觉或豁免 → digest:status
```

先跑 `npm run doctor -- --offline`；抓取前可跑 `npm run source:probe -- --date DATE`；运行中用 `npm run digest:status -- --date DATE --watch`。

## 2. 状态文件地图

| 文件/目录 | 谁写 | 说明 |
|---|---|---|
| `data/current/deep-analysis-result.json` | 分析/恢复入口 | 34 篇正式结果、失败与资格证明 |
| `data/current/blog-generation-manifest-<date>.json` | blog:generate | 页面清单 |
| `data/current/blog-review-passes/failure-<date>.json` | blog:review | 审查通过缓存与失败集 |
| `data/runtime/llm-account-pool.json` | Node/Python 账号池 | 轮转游标与冷却（0600） |
| `data/runtime/llm-usage/` | 请求封装 | 逐事件用量，不推算未知费用 |
| `logs/summaries/<date>-summary.log` | Node/Python 入口 | 人话阶段摘要 |

## 3. 恢复决策树

```
失败
├─ 429/5xx → npm run source:probe；仍失败就等待/换官方 OAI
├─ 账号池耗尽 → npm run llm:accounts；确认额度/冷却
├─ 表格/Reader 问题 → npm run recover -- --date DATE
│    ├─ 少量节点可人工改 → npm run manifest:new -- --spec SPEC.json（dry-run 先看）
│    └─ 需要新轮次 → 按 recover 给出的命令走正常入口
├─ 博客审查失败 → 先看 data/current/blog-review-failure-<date>.json；误报用 review-overrides 记录证据
└─ 推送/部署 → push --dry-run → push → verify:web → publish:finish
```

原则：不改旧失败与费用、不跳过来源/质量门禁、不自动豁免视觉；所有命令都可先 dry-run 或只读查看。
