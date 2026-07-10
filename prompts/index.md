# Prompt 文档索引

本目录存放 audio-paper-digest skill 的所有 LLM prompt，与代码分离以便独立迭代。

## 文档列表

| 文件 | 用途 | 调用位置 |
|------|------|----------|
| [filter.md](filter.md) | 筛选阶段：判断单篇论文是否与语音/音乐/音频相关 | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | 深度分析阶段（第一轮）：纯文本阅读后输出结构化报告 | `deep-analyzer.js` |
| [image-supplement.md](image-supplement.md) | 深度分析阶段（双模型模式）：副模型只输出 JSON 插图计划，代码局部插图，并可用 `replacement` 调整插图附近短句 | `deep-analyzer.js` |
| [opensource-scan.md](opensource-scan.md) | 开源扫描阶段（第二轮）：专门提取开源链接和复现信息 | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | 深度分析阶段（第三轮）：对照原文审校重写前两轮结果 | `deep-analyzer.js` |
| [method-fill.md](method-fill.md) | 深度分析后处理：方法章节过短或空泛时补写结构化方法说明 | `deep-analyzer.js` |
| [table-fill.md](table-fill.md) | 深度分析后处理：实验结果缺少可见表格或出现省略标记时补表 | `deep-analyzer.js` |
| [structure-repair.md](structure-repair.md) | 审校结果缺少必要章节时，由主模型只修复完整报告结构 | `deep-analyzer.js` |
| [scoring-audit.md](scoring-audit.md) | 正文修复完成后由主模型最终审计文档类型、八维评分与扣分归属，只输出 JSON | `deep-analyzer.js` |

## 占位符规范

各 prompt 中的模板占位符用 `{变量名}` 表示，代码读取后通过字符串替换注入实际值。具体占位符见各文档内的"调用方式"章节。

## 加载规则

- `loadPrompt()` 只读取 markdown 中的第一个 fenced code block 作为运行时 prompt。
- 如果 prompt 正文内部需要展示代码块，外层 fenced code block 必须使用更长 fence（如 ````）或 `~~~~`，避免被第一个内部 ``` 截断。
- 新增 `{变量名}` 占位符时，必须同步更新调用代码传参和测试；运行时未替换占位符只会警告，不会自动阻断流程。

## 修改建议

- 调整标签体系、评分标准、输出格式时，直接编辑对应 markdown 文件即可，无需改代码。
- 类型感知评分字段为 `document_type`，受控值为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究、应用研究；`deep-analysis.md`、`gap-fill.md` 及英文版本必须同步维护。
- 评分必须保持声明—证据匹配和“单一问题单一主维度扣分”，副模型 `image-supplement.md` 不得参与类型判断或评分。
- `scoring-audit.md` 的 `{validationFeedback}` 用于把代码校验错误反馈给下一次局部审计；`structure-repair.md` 仅在共享结构契约发现缺失标题时调用。
- 保持占位符名称与代码中的替换逻辑一致。
- 修改 prompt 后建议运行一次单篇分析或 `quick-test.js` 验证效果。
