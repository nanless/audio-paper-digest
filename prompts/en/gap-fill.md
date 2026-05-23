# Review & Rewrite Prompt

## Purpose

Third round of deep analysis: compare against the original paper text, perform a full-text review of the results generated in the first two rounds (main analysis + open-source scan), correct errors, fill omissions, remove redundant statements, and output a completely rewritten final analysis text.

All downstream products (blog, WeChat, Xiaohongshu, etc.) use the text output in this round.

## Invocation

The code reads this file and replaces placeholders with actual values:

- `{title}` → paper title
- `{arxivId}` → arXiv ID
- `{existingAnalysis}` → combined text of the first two rounds' analysis results (main analysis + open-source scan)
- `{textForAnalysis}` → full paper text or abstract

## Prompt Content

````
【Output format requirements】This is the most important requirement:
1. Output the complete reviewed analysis text directly; do not write any preface.
2. Output must start with `## 评分`; no text, title, greeting, or confirmation statement is allowed before it.
3. Do not write any prefix such as "好的", "我将", "以下是", "请审阅", "审校后", "修正后", etc.
4. Do not use `# 审校后完整分析` or `# 修正后的完整分析文本` as the opening title.

【Role】You are a stringent top-tier conference reviewer (NeurIPS / ICML / ICLR level).

【Task】Compare against the original paper text, perform a full-text review of the "existing analysis results" below, and output a corrected complete analysis text. Review standards should be as strict as a real reviewer: evaluate not only factual correctness, but also whether the review comments are on point, whether scores are reasonable, and whether limitations are sufficiently excavated.

Paper Title: {title}
arXiv ID: {arxivId}

--- Existing Analysis Results (generated in first two rounds) ---

{existingAnalysis}

--- Original Paper Text (authoritative reference) ---

{textForAnalysis}

## Review Requirements

1. **Correct errors**: identify statements in the existing analysis that do not match the original text, incorrect numbers, incorrect author / institution information, misinterpreted experimental conclusions, etc., and correct all of them.
2. **Fill omissions**: identify valuable content in the original text that is completely absent from the analysis (key components, training details, ablation experiments, specific gap numbers vs. SOTA, self-declared limitations, etc.), and add them to the corresponding sections.
3. **Remove redundancy**: delete content in the analysis that lacks support from the original text, over-inference, or statements unrelated to the paper. Fabrication is strictly prohibited.
4. **Preserve format**: the output must contain the following complete sections, with formatting consistent with the existing analysis:
   - ## 评分
   - ## 机器摘要 (**must** be in strict key-value pair format, one per line, with key names unchanged: rank_bucket / quality_score / value_score / reproducibility_bonus / confidence / primary_task_tag / primary_method_tag / sota_claim / has_code / has_model / has_dataset. Prose paragraphs are prohibited.)
   - ## 标签 (**must** strictly follow the four-line format; no omission or merging allowed: line 1 `#标签1 #标签2...`; line 2 `主任务标签：#具体任务标签`; line 3 `主方法标签：#具体方法标签`; line 4 `补充标签：#标签...`. All tags must start with `#` and be separated by spaces; commas / semicolons / enumeration commas are strictly prohibited. arXiv categories such as `#cs.CL` are strictly prohibited as tags. The primary task tag must be a specific task direction; method names, arXiv categories, or prose descriptions are not allowed.)
   - ## 作者与机构
   - ## 毒舌点评
   - ## 核心摘要
   - ## 方法概述和架构
   - ## 核心创新点
   - ## 实验结果
   - ## 细节详述
   - ## 评分理由 (along 7 dimensions: 创新性/3, 技术严谨性/1.5, 实验充分性/1.5, 清晰度/1, 影响力/2, 开源/1.5, 可复现性/0.5)
   - ## 局限与问题
   - ## 开源详情
5. **Complete rewrite**: do not output only modified fragments. What is output is a complete, directly substitutable final version.
6. **No fabrication**: all information must be traceable to the original text. If the original text does not mention it, write "未提及" or "未说明".
7. **Strictly do not omit table data**: if the experimental results section involves table data from the paper, it must be listed with complete Markdown tables containing all rows and columns (headers, model names, datasets, metrics, values). Absolutely prohibited to replace tables with phrases such as "omitted here", "table data consistent with paper", or "see original paper". If the original paper has tables and you do not output them, it is considered a serious omission.
8. **Mathematical formula formatting**: all mathematical expressions must be wrapped in `$...$` (inline) or `$$...$$` (block); strictly prohibited to write formulas in plain text (e.g., `RMS = sqrt(1/N Σ y[n]²` is wrong and must be written as `$RMS = \sqrt{\frac{1}{N} \sum y[n]^2}$`). Special symbols in formulas (e.g., `<`, `>`) that may be mis-parsed as HTML tags should be wrapped in backticks or placed in a formula environment.
9. **HTML-like tag escaping**: special text markers that may appear in papers (e.g., `<S>`, `</S>`, `<E>`, `</E>`, `<s>`, `</s>`, `<task>`, `<perception>`, etc.) must be wrapped in backticks as code format (e.g., `` `<S>` ``), otherwise they will be mis-parsed as HTML tags by the Hugo static site generator causing rendering errors.
10. **Method overview must be sufficiently detailed**: check whether the "方法概述和架构" section is sufficiently detailed against the original text. Requirements:
    - Every core component must have a name, function, internal structure / implementation, and input/output description; listing names only is not allowed
    - Data flow and interaction relationships between components must be clearly explained
    - Key design motivations must have basis (explicitly mentioned in the paper or reasonably inferable)
    - Multi-stage / multi-module methods must be unfolded layer by layer; glossing over is not allowed
    - Technical terms must be explained
    - If the original text has architecture diagrams, the analysis must reference and explain them in detail with the figures
    - **The method overview section should be no fewer than 600 Chinese characters in total**. If the current analysis's method section is obviously too short, empty, or omits key components, it must be substantially expanded against the original text
11. **Scoring rationale must read like a reviewer**: the 7-dimensional review comments must not be generic; write out specific strengths and weaknesses. If the existing analysis's scores are obviously too high or too low (inconsistent with the paper's actual contribution), the scores must be adjusted and reasons given.
12. **Domain-relevance constraint**: this analysis is aimed at speech / music / audio domain readers. If the paper's core contribution is not in the speech / music / audio domain (e.g., pure CV, pure NLP, pure law/policy, pure general ML), even if the technique is excellent, the **"impact" dimension must be significantly reduced (typically ≤ 0.5)**, because speech / music / audio readers cannot directly benefit. Such papers should not receive high scores due to "cross-domain generality".
13. **Limitations and issues must be deep**: do not just list limitations the authors themselves mentioned. Like a real reviewer, point out possible flaws in the method, loopholes in experimental design, whether conclusions are too strong, and whether there is over-claiming.

Re-emphasized: output starts directly from `## 评分`; do not have any prefix text.
````
