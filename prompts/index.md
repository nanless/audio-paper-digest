# Prompt 文档索引

本目录存放 audio-paper-digest skill 的所有 LLM prompt，与代码分离以便独立迭代。

## 文档列表

| 文件 | 用途 | 调用位置 |
|------|------|----------|
| [filter.md](filter.md) | 筛选阶段：判断单篇论文是否与语音/音乐/音频相关 | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | 深度分析阶段（第一轮）：纯文本阅读后输出结构化报告 | `deep-analyzer.js` |
| [manual-analysis-record.md](manual-analysis-record.md) | Manual v3 人工全文写作规范：要求论证推进、完整方法流、比较实验、复现信息、双层局限和维度专属评分 | `create-manual-analysis-spec.js`（以模板 SHA 绑定，不调用 LLM） |
| [image-supplement.md](image-supplement.md) | 深度分析阶段（双模型模式）：副模型只输出严格 JSON 插图计划，代码只新增图片及相邻说明，不替换主模型原文 | `deep-analyzer.js` |
| [visual-summary.md](visual-summary.md) | 全部博客发布后，对最终评分 TOP 10 各生成一张覆盖问题、方法、实验、结论与局限的纵向长图 | Codex 内置 `image_gen`（发布后 Agent 阶段） |
| [digest-cover.md](digest-cover.md) | 全部博客发布后的汇总图：展示批次标题、热门方向和 TOP 10 排行榜 | Codex 内置 `image_gen`（发布后 Agent 阶段） |
| [opensource-scan.md](opensource-scan.md) | 开源扫描阶段（第二轮）：专门提取开源链接和复现信息 | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | 深度分析阶段（第三轮）：对照原文审校重写前两轮结果 | `deep-analyzer.js` |
| [method-fill.md](method-fill.md) | 深度分析后处理：方法章节过短或空泛时补写结构化方法说明 | `deep-analyzer.js` |
| [table-fill.md](table-fill.md) | 深度分析后处理：正文明确引用原文表格却缺表，或出现非法省略标记时，补充有行列上限的关键证据表 | `deep-analyzer.js` |
| [structure-repair.md](structure-repair.md) | 审校结果缺少必要章节、正文不足或实验表格超限时，由主模型局部修复完整报告契约 | `deep-analyzer.js` |
| [scoring-audit.md](scoring-audit.md) | 正文修复完成后由主模型最终审计文档类型、八维评分与扣分归属，只输出 JSON | `deep-analyzer.js` |

## 占位符规范

各 prompt 中的模板占位符用 `{变量名}` 表示，代码读取后通过字符串替换注入实际值。具体占位符见各文档内的"调用方式"章节。

## 加载规则

- `loadPrompt()` 只读取 markdown 中的第一个 fenced code block 作为运行时 prompt。
- 如果 prompt 正文内部需要展示代码块，外层 fenced code block 必须使用更长 fence（如 ````）或 `~~~~`，避免被第一个内部 ``` 截断。
- 新增 `{变量名}` 占位符时，必须同步更新调用代码传参和测试；运行时未替换占位符只会警告，不会自动阻断流程。

## 修改建议

- 调整标签体系、评分标准或输出格式时，必须同步 `scripts/utils.js`、`scripts/utils.py`、分析/发布校验器、测试 fixture 和中英文版本。
- 类型感知评分字段为 `document_type`，受控值为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究、应用研究；`deep-analysis.md`、`gap-fill.md` 及英文版本必须同步维护。
- 评分必须保持声明—证据匹配和“单一问题单一主维度扣分”，副模型 `image-supplement.md` 不得参与类型判断或评分。
- `image-supplement.md` 的顶层只能包含 `insertions` 数组；只有严格 `{"insertions":[]}` 表示确认没有高价值图片，schema 错误保持可重试。
- `image-supplement.md` 额外使用 `{anchorCatalog}`；副模型必须从目录中选择稳定 `paragraph_id`，旧自由文本 `anchor` 仅用于兼容历史响应。
- `scoring-audit.md` 的 `{validationFeedback}` 用于把代码校验错误反馈给下一次局部审计；`structure-repair.md` 仅在共享结构契约发现缺失标题时调用。
- `visual-summary.md` 仅使用已审计的摘要、方法和实验章节构造编辑性说明图；必须保持为单一第一个 fenced code block。论文长图与封面均由内置 `image_gen` 整张生成，优先使用当前最高可用纵向分辨率；真实关键图只作结构/数值依据，无法可靠校验的长文本或精确数字不得进入图中。确定性渲染器只用于本地调试或离线兜底。
- 保持占位符名称与代码中的替换逻辑一致。
- 修改 prompt 后建议运行一次单篇分析或 `quick-test.js` 验证效果。
