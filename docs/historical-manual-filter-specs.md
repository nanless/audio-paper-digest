# 历史 Manual 筛选决定归档

`tests/fixtures/historical-manual-filter-specs.json` 是 2026-08-20、2026-08-25 和
2026-08-27 三个批次的不可变筛选决定归档。它替代了原来放在 `scripts/` 下的三个
日期硬编码生成器，但不是新的生产入口，也不能覆盖 `manual-fetch --select` 的逐篇
完整性门禁。

归档采用 `historical-manual-filter-spec-archive-v1`：

- 保存每个批次的全部候选 ID 和生成否定理由时使用的标题；
- 保存全部 `related=true` 论文及其人工理由；
- 保存负向理由的精确版本化模板和统一 `reviewedFields`；
- 保存 reviewer、reviewedAt、reviewProtocol 和 candidateCount；
- 绑定原始 `raw-candidates.json`、最终 `filter-decisions.json`、原
  `manual-filter-spec-<date>.json`、候选 ID 投影和逐篇决定投影的 SHA-256。

因此归档可以确定性重构每一篇论文的 `related`、`reason` 和
`reviewedFields`，并重构出与原文件字节 SHA 完全相同的
`manual_offline` v1 JSON。`tests/historical-manual-filter-specs.test.js` 会在 CI 中逐篇
重放并验证这些约束，同时确保日期生成器没有重新进入生产目录。

归档时验证结果：

| 日期 | 全部候选 | related=true | 决定差异 |
|---|---:|---:|---:|
| 2026-08-20 | 296 | 20 | 0 |
| 2026-08-25 | 521 | 46 | 0 |
| 2026-08-27 | 317 | 21 | 0 |

未来需要历史审计时应读取该 fixture 或对应日期的运行数据快照；不得恢复日期专用
JavaScript 生成器。新的批次继续使用逐篇分片和
`npm run manual:filter-merge`，不能复制历史选择清单。
