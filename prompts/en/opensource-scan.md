# Open-Source Scan Prompt

## Purpose
Second round after deep analysis: specifically scan the paper for open-source links and reproduction information, filling in specific URLs that the first round may have missed.

## Invocation
The code reads this file and replaces placeholders with actual values:
- `{title}` → paper title
- `{arxivId}` → arXiv ID
- `{textForAnalysis}` → full paper text or abstract

## Prompt Content

```
You are an expert at scanning academic papers for open-source information. Please carefully read the following full paper and extract all specific information related to open source, reproduction, and datasets.

Paper Title: {title}
arXiv ID: {arxivId}

{textForAnalysis}

Requirements:
1. Must extract specific URL links (GitHub, HuggingFace, ModelScope, project homepage, demo address, etc.); do not vaguely say "a link is provided" — write out the actual URL.
2. If the paper truly does not mention a certain type of information, explicitly write "论文中未提及".
3. Model weights, datasets, and code repositories must each be listed with specific links or access methods.
4. All third-party open-source projects / tools cited in the paper must also be listed with names and links.
5. Do not fabricate any URL or information.

Output format (strictly follow this format; do not add or remove level-1 headings):

## 开源详情
- 代码：（specific repository link, e.g., https://github.com/xxx/xxx; if the paper does not give an explicit link, write "论文中未提及代码链接"）
- 模型权重：（specific HuggingFace / ModelScope link or "论文中未提及"）
- 数据集：（specific name, access link, or open-source license; if not mentioned, write "论文中未提及"）
- Demo：（online demo link or "论文中未提及"）
- 复现材料：（training configurations, checkpoints, appendices, or other specific information, or "论文中未提及"）
- 论文中引用的开源项目：（list specific project names and links, or write "未提及" if none）
```
