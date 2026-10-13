# Reader 表格事实审校

正常深度分析和 Reader 刷新在来源硬核验通过后增加 `apiReaderTableAudit`。当前适用范围是已登记的日更或 fresh v2 封存运行。旧历史直改使用另一套来源格式，继续执行原有的独立来源核验，不伪称已经接受此审校。日更入口拒绝夹带历史直改身份，不能用它省去审校。

审校接收完整读者文章、每张表的列与行、原表完整矩阵及跨行跨列元数据、逐字来源引文、完整原文和已核验的事实约束。检查数据集、模型、实验条件、列头、单位、比较方向和不等号；数字能在原文找到，不能单独证明归属正确。原表 DOM 与原文始终不改。模型只能报告逐字正文和原文依据，不能覆盖来源硬检查。

已有合法 Reader 缺少新证明时复用原正文，增加审校请求，不先重生成长文。审校发现错误时进入既有正文和表来源局部修复，修后仍执行整篇解析；改变 Reader 后重新审校。相关解释的错误也定位到对应正文或术语解释。修复未改变文章时停止，不清旧费用或次数。

每次请求经公共模型路由，审校独立登记请求回执和费用，不能算作原长文请求的一部分。默认输出 12000 tokens，可用 `PD_API_READER_TABLE_AUDIT_MAX_TOKENS` 覆写；预算、模型地址、提示词和输入均进入身份。最多六个审校输入版本，每个版本网络失败最多两次。与 Reader 生成共用重阶段并发限制；审校结束后才进入修复，避免嵌套占用同一名额。

冷启动须重新核验来源文件、正文 SHA、完整表格覆盖、实际响应 SHA、请求回执及原模型身份，不能只信 `status: complete`。同一正文的成功审校可复用已声明配置，不因当前模型或预算改变而重复收费；正文、来源或事实约束改变则不能沿用。旧审校响应保存在阶段记录中，不篡改旧事实审查证明。

普通测试使用本地网络替代响应，验证真实公共刷新、补丁解析、整篇解析、检查点和独立费用登记，不启动生产模型：

```bash
node --test tests/reader-table-semantic-audit.test.js tests/reader-table-semantic-audit-public.test.js
```

真实来源回放另用 `PD_TABLE_SEMANTIC_AUDIT_REAL_MANIFEST` 指向 JSON 清单。清单含 `sourceProject` 与 `samples`；每项给出 `paperFile`、`feedbackFile`、`tableIndex`、`claimIndex`、`quoteIndex`、`message`、`correction`。它只读封存来源和原稿，检查确证错误的诊断、修复范围及冷启动格式。缺清单明确跳过。成功审校响应是本地模拟，不能据此宣称实际文章已完成模型审校。

```bash
PD_TABLE_SEMANTIC_AUDIT_REAL_MANIFEST=/absolute/review-manifest.json node --test tests/reader-table-semantic-audit-real.test.js
```
