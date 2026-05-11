# Prompt 文档索引

本目录存放 audio-paper-digest skill 的所有 LLM prompt，与代码分离以便独立迭代。

## 文档列表

| 文件 | 用途 | 调用位置 |
|------|------|----------|
| [filter.md](filter.md) | 筛选阶段：判断单篇论文是否与语音/音频相关 | `fetch-papers.js` |
| [deep-analysis.md](deep-analysis.md) | 深度分析阶段（第一轮）：阅读全文+图片后输出结构化报告 | `deep-analyzer.js` |
| [gap-fill.md](gap-fill.md) | 深度分析阶段（第三轮）：对照原文审校重写前两轮结果 | `deep-analyzer.js` |
| [opensource-scan.md](opensource-scan.md) | 开源扫描阶段（第二轮）：专门提取开源链接和复现信息 | `deep-analyzer.js` |

## 占位符规范

各 prompt 中的模板占位符用 `{变量名}` 表示，代码读取后通过字符串替换注入实际值。具体占位符见各文档内的"调用方式"章节。

## 修改建议

- 调整标签体系、评分标准、输出格式时，直接编辑对应 markdown 文件即可，无需改代码。
- 保持占位符名称与代码中的替换逻辑一致。
- 修改 prompt 后建议运行一次单篇分析或 `quick-test.js` 验证效果。
