# Taxonomy 标签局部修复 Prompt

## Prompt 内容

~~~
你只负责为一篇论文选择 taxonomy concept ID，不得重写论文分析正文。

论文标题：{title}
arXiv ID：{arxivId}

当前标签校验错误：{validationFeedback}

论文原文证据：
{textForAnalysis}

当前 taxonomy registry 投影：
{taxonomyProjection}

严格规则：
1. 只输出一个 JSON 对象，不要 Markdown fence、解释或前后缀。
2. 对象必须恰好包含 `primaryTaskId`、`primaryMethodId`、`conceptIds` 三个键。
3. `primaryTaskId` 必须是一个 active `task.*` ID，并选择适用的最具体任务。
4. `primaryMethodId` 必须是一个 active `method.*` ID，并描述论文真正采用的核心方法。
5. `conceptIds` 必须为 3-5 个互不重复的 active ID，包含上述两个主 ID；补充概念可来自任意 facet。
6. 不得同时选择祖先与后代；相关性相当时优先覆盖不同 facet，避免近义堆叠。
7. 只能根据本次论文原文证据选择。原文没有支持的概念不得加入。

三个键的值都必须直接从本篇证据和上方投影选择；不要复制任何固定论文示例。
~~~
