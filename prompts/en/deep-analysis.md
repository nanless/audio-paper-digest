# Deep Analysis Prompt — In-depth Reading of a Single Paper

## Purpose
Reference translation of the Chinese deep-analysis prompt. The current runtime loads `prompts/deep-analysis.md` only: the primary model reads text only, and figures are handled later by `prompts/image-supplement.md` in dual-model mode.

## Invocation
If this file is ever wired into runtime, the code would need to replace placeholders with actual values:
- `{hasFullText}` → "Below is the full paper; please read all technical details carefully." or "Below is the paper abstract."
- `{textForAnalysis}` → excerpt from the full paper or the abstract
- `{title}` → paper title
- `{authors}` → author list (comma-separated string)
- `{categories}` → paper categories (comma-separated string)
- `{arxivId}` → arXiv ID

## Prompt Content

````
Please perform an in-depth analysis of the following paper from the perspective of a top-tier conference reviewer (NeurIPS / ICML / ICLR style). {hasFullText}

Paper Title: {title}
Authors: {authors}
Categories: {categories}
arXiv ID: {arxivId}
Link: https://arxiv.org/abs/{arxivId}

{textForAnalysis}

Please output in the following fixed format (in Chinese). Do not add or remove any level-1 headings. Missing information must be explicitly written as "not stated", "not provided", or "not mentioned in the paper". Do not guess based on common sense, author reputation, institution reputation, email addresses, external web pages, or historical memory.

## 评分
First output the total score alone; the format must be: X.X/10

## 机器摘要
**Must strictly follow the key-value pair format below, one key-value pair per line. Key names must match the examples exactly; prose paragraphs are prohibited. If any item cannot be determined, write "未说明".**

```
document_type: 方法研究 / 系统技术报告 / 模型报告 / 数据集与基准 / 综述 / 理论研究 / 应用研究
rank_bucket: 前10% / 前25% / 前50% / 后50%
innovation: X.X
technical_rigor: X.X
experimental_sufficiency: X.X
clarity: X.X
impact: X.X
open_source: X.X
reproducibility: X.X
engineering_score: X.X
confidence: 高 / 中 / 低
primary_task_tag: #标签
primary_method_tag: #标签
sota_claim: 是 / 否 / 未说明
has_code: 是 / 否 / 未说明
has_model: 是 / 否 / 未说明
has_dataset: 是 / 否 / 未说明
```

**Field descriptions**:
- `document_type`: first classify the primary contribution form; choose exactly one of 方法研究 / 系统技术报告 / 模型报告 / 数据集与基准 / 综述 / 理论研究 / 应用研究. Type selects the applicable evidence standard and never directly adds or removes points
- `rank_bucket`: choose exactly one from 前10% / 前25% / 前50% / 后50%
- `innovation`: novelty, range 0–2
- `technical_rigor`: technical rigor, range 0–1.5
- `experimental_sufficiency`: experimental thoroughness, range 0–1.5
- `clarity`: clarity, range 0–1
- `impact`: impact and importance, range 0–1.5
- `open_source`: open-source completeness, range 0–1.5
- `reproducibility`: reproducibility (documentation/detail sufficiency), range 0–0.5
- `engineering_score`: engineering/practical value, range 0–1.5
- `confidence`: 高 / 中 / 低
- `primary_task_tag`: select the single most important **task** tag from the tags (starting with `#`, e.g. `#语音识别`, `#语音合成`, `#音频生成`, `#音乐生成`, `#音频降噪`, `#语音情感识别`, etc.). **Do not** use method names, arXiv categories, or prose descriptions as task tags.
- `primary_method_tag`: select the single most important **method** tag from the tags (starting with `#`, e.g. `#扩散模型`, `#预训练`, `#对比学习`, `#自监督学习`, etc.)
- `sota_claim`: whether the paper explicitly claims to achieve SOTA
- `has_code` / `has_model` / `has_dataset`: whether code / model / dataset is provided

【Scoring Rules】
1. First determine the paper's relative position among contemporaneous work in the same direction; choose only from 前10% / 前25% / 前50% / 后50%. 前10% corresponds to breakthrough work; 前25% to clearly excellent work; 前50% to acceptable-to-good work; 后50% to work with notable issues.
2. Dimension maxima: Innovation (0–2) + Technical Rigor (0–1.5) + Experimental Thoroughness (0–1.5) + Clarity (0–1) + Impact (0–1.5) + Open Source (0–1.5) + Reproducibility (0–0.5) + Engineering/Practical Value (0–1.5) = 11. Total score = sum of all dimensions, capped at 10 (anything above 10 is counted as 10), rounded to 0.1.
3. Scores must be discriminative but not artificially suppressed. Scores ≥ 9.0 are reserved for truly milestone-potential work; 8.0–8.5 for solid contributions on important problems with clear impact; most solid but non-breakthrough papers should fall in 6.0–7.5. Do not lower the innovation score of engineering papers simply because they "combine existing techniques" — what matters is whether the combination yields new insight, solves a real important problem, and brings verifiable significant improvement.
4. rank_bucket must be consistent with the final score recalculated from the eight sub-scores: total ≥ 9.0 → 前10%; total ≥ 7.5 and < 9.0 → 前25%; total ≥ 5.5 and < 7.5 → 前50%; total < 5.5 → 后50%.
5. Do not reject paper quality simply because the task is niche. Niche, vertical, special-population, pathological speech, animal sounds, etc., should be scored normally on "innovation" and "technical rigor" — as long as the problem is well defined and the method has substantive breakthrough, the innovation score must not be suppressed due to narrow audience; however, "impact" must be scored low (typically ≤ 0.5), because such work naturally has limited broad domain-driving effect and follow-up value. Experimental thoroughness may be moderately reduced only for aspects related to dataset generality.
6. Use claim-evidence matching: identify the core claims first, then judge whether experiments, proofs, system tests, or data analyses support those claims. Do not mechanically demand the same evidence from every document type.
7. Use a single-issue-single-primary-dimension rule. Missing artifacts belongs to Open Source; missing hyperparameters or reproduction instructions belongs to Reproducibility; missing evidence for claims belongs to Experimental Thoroughness; writing or presentation problems belong to Clarity; derivation, assumption, or logic flaws belong to Technical Rigor. Never deduct the same disclosure gap across multiple dimensions.
8. "Cannot verify" is not the same as "demonstrably wrong". When disclosure is insufficient, lower `confidence` and deduct only in directly relevant dimensions. Closed source or missing implementation detail alone is not evidence of flawed technical logic.
9. 【Domain-Relevance Constraint — Most Important】This analysis is aimed at **speech / music / audio domain readers**. If the paper's core contribution is not in speech / music / audio (e.g., pure computer vision, pure natural language processing, pure law/policy frameworks, pure general machine learning theory, pure robotics/embodied AI), even if the technical quality is excellent, the **"impact" dimension must be significantly reduced (typically ≤ 0.5)**, because its direct relevance and practical value for speech / music / audio domain readers is limited. Such papers should not receive high scores due to "cross-domain generality" or "the method could theoretically be adapted to audio". Only when the paper explicitly takes speech / music / audio as the core experimental object, core evaluation task, or core application scenario can impact be scored normally.
10. Apply type-specific evidence: method research uses representative baselines, ablations, cross-dataset generalization, and statistics; system/model reports use end-to-end quality, latency, throughput, cost, scale, stress tests, fair competitor comparisons, and failure cases, with component ablations required only for component-level causal claims; datasets/benchmarks use coverage, annotation quality, leakage controls, protocols, and baselines; surveys use search methodology, coverage, taxonomy, and synthesis; theory uses proofs, assumptions, boundaries, and counterexamples; applied research uses real-world settings, external validation, user studies, and deployment constraints.
11. System-level novelty, hardware-software co-design, scaling methods, and new capabilities produced by engineering combinations can count as Innovation. Product descriptions without inspectable evidence cannot receive high Innovation or Experimental scores.
12. Document type provides no fixed bonus, floor, or exemption. Closed reports still lose Open Source and Reproducibility points as warranted; pure theory may legitimately receive zero Engineering points. The common eight dimensions remain unchanged.

【Dimension Explanations】
- Innovation (0–2): Is the problem novel? Does the method have essential breakthrough? Is the insight deep? Is the distinction from SOTA clear and convincing? Do not give low scores merely for "combining existing techniques"; what matters is whether the combination yields new insight and solves a real problem. 2.0 for true breakthroughs, 1.5 for clear innovation, 1.0 for minor improvements, 0.5 for trivial improvements.
- Technical Rigor (0–1.5): Evaluate correctness and internal logic of the disclosed derivations, algorithms, systems, assumptions, and boundaries. Closed source, absent hyperparameters, or missing code are not by themselves Technical Rigor defects.
- Experimental Thoroughness (0–1.5): Apply the evidence standard selected by `document_type`; the central question is whether evidence supports the claims. Require ablations only for component-level causal attribution, and do not force method-paper conventions onto surveys, theory, datasets, or system reports.
- Clarity (0–1): Evaluate organization, notation, explanations, figures, and readability only. Missing reproduction detail belongs to Reproducibility unless the writing itself is unclear.
- Impact (0–1.5): Domain-driving effect, potential follow-up value, practical application potential, relevance to audio/speech readers. When scoring, consider the following factors:
  - **Research成果 itself**: achieving SOTA on important benchmarks, releasing large-scale datasets/tools, solving long-standing practical problems in the domain
  - **Boundary for author/institution information**: Only use facts explicitly provided by the paper text, such as author list, affiliations, released resources, system deployment, data scale, or benchmark coverage, as background. Do not add points based on external memory, author fame, institution fame, or stereotypes about organizations.
  - Narrowly applicable minor improvements or non-audio-core work can only receive low scores
- Open Source (0–1.5): Is the paper's core content publicly available? **Note: Different papers have different core content** — model papers' core is code + model weights, dataset papers' core is the dataset, tool papers' core is the code repository, theory papers' core is proof materials or experiment code. Scoring rules:
  - **1.5**: Core content is open-sourced (including cases where links are provided indirectly through demo pages) with complete documentation
  - **1.2**: Core content is open-sourced but documentation is incomplete
  - **1.0**: Part of the core content is open-sourced (e.g., only code without model, or only model without code)
  - **0.5**: Authors promise to open-source but haven't released yet
  - **0.2**: Only provides demo but no open-source core content
  - **0**: Completely closed with no promises
- Reproducibility (0–0.5): Documentation sufficiency beyond open source — training details, hyperparameters, hardware environment, experimental configuration, reproduction steps — are they sufficient for others to reproduce without relying on the authors? 0.5 for complete details; 0.25 for partially missing information; 0 for completely missing key details.
- Engineering/Practical Value (0–1.5): Evaluates the paper's engineering落地能力, practical reference value, and industrial reusability. Scoring criteria:
  - **1.5**: Establishes a complete industrial-grade pipeline (e.g., large-scale system reports, benchmark construction, standardized processes, end-to-end production solutions), with extensive engineering details and reusable components that can directly guide practical implementation.
  - **1.0**: Has clear engineering contributions (e.g., detailed system design, modular architecture, complete training/deployment documentation), with significant reference value for engineering practice.
  - **0.5**: Has some engineering details (e.g., implementation tricks, optimization experience, engineering trade-off analysis), helpful for reproduction but not systematic.
  - **0**: Pure theory or pure academic research, no engineering落地 value (this is normal for such papers; score 0 here).

【Reference Ranges】
- 9.0–10.0: Breakthrough contribution, domain milestone candidate, method or result has paradigm-shifting potential
- 8.0–8.5: High-level work, solid contribution on an important problem, clear impact or significant performance improvement, worth careful reading
- 6.5–7.5: Valuable but not outstanding, or has minor flaws, acceptable-to-good, of reference value to researchers in specific directions
- 5.0–6.0: Limited innovation, weak experiments, conclusions not important or have obvious flaws, suitable only for quick skimming
- 1.0–4.5: Serious problems, derivation errors, experiments do not support conclusions, or extremely poor writing, not recommended to invest time

## 标签

**Strict format requirements (must be followed; no lines may be omitted):**

```
#标签1 #标签2 #标签3 #标签4
主任务标签：#任务标签
主方法标签：#方法标签
补充标签：#标签 #标签
```

**Example (assuming the paper is about speech recognition):**

```
#语音识别 #语音大模型 #多语言 #低资源
主任务标签：#语音识别
主方法标签：#语音大模型
补充标签：#多语言 #低资源
```

**Format rules (violations will cause parsing failures):**
1. The first line is the complete list of all tags; each tag must start with `#` and be separated by spaces. Do not use commas, semicolons, or enumeration commas.
2. **The second line must** start with `主任务标签：`, followed by a task tag starting with `#` (select the most specific task tag from the tag table below).
3. **The third line must** start with `主方法标签：`, followed by a method tag starting with `#` (select the most core method tag from the tag table below).
4. The fourth line starts with `补充标签：`, followed by the remaining tags.
5. **Do not** use arXiv categories as tags (e.g., `#cs.CL`, `#cs.AI`, `#eess.AS`, etc.).
6. **Do not** output plain text without a `#` prefix (e.g., `uncertainty_estimation`, `Speech Processing`, etc.).
7. **Do not** let a single tag contain multiple comma/semicolon-separated items (e.g., `#语音情感识别；政治演讲分析` is wrong; split into two independent tags).
8. All tags must be selected from the tag table below; do not invent new tags.

【Tag Rules】
1. Total of 3–5 tags, strictly selected from the tag table below; do not invent new tags.
2. Must contain at least one 【Task】 tag and at least one 【Method】 or 【Model/Architecture】 tag.
3. Prefer the most specific tag; avoid broad hypernyms.
4. Only use #多模态模型 when the paper's core contribution is multimodal modeling, or when speech/music/audio and other modalities are equally important.
5. When #多模态模型 is already used, usually do not also use #音视频 unless the paper specifically focuses on audio-visual scenarios.
6. Choose either #音频大模型 or #语音大模型 according to the paper's core object.
7. If #扩散模型 or #流匹配 is already used, generally do not also use #生成模型 unless the paper indeed discusses a more general generation framework.

【Tag Table (by category)】

【Model / Architecture】
#音频大模型、#语音大模型、#多模态模型、#统一音频模型、
#大语言模型、#生成模型、#自回归模型、#端到端

【Task — Speech】
#语音合成、#语音识别、#语音增强、#语音分离、
#语音克隆、#语音转换、#语音翻译、#语音情感识别、#语音活动检测、
#说话人识别、#说话人验证、#说话人分离、#说话人日志、
#语音对话系统、#语音伪造检测、#语音匿名化、#语音生物标志物、#语音编辑、#语音质量评估、#语音打断处理、
#语音去噪、#语音超分辨、#语音补全、#语音风格迁移、#情感语音合成、#语音编码、#语音检索、#语音问答、#语音摘要

【Task — Audio】
#音频生成、#音频分类、#音频事件检测、#音频场景理解、#音频问答、#音频检索、
#音频安全、#音频深度伪造检测、
#空间音频、#3D音频、#声源定位、#生物声学、#音频编码、#音频修复、#音频水印、#音频质量评估、
#声景生成、#音频超分辨、#音频指纹、#房间声学、#回声消除

【Task — Music】
#音乐生成、#音乐信息检索、#音乐理解、#歌唱语音合成、#音乐转录、#和弦识别、#节拍跟踪、#音乐源分离、#音乐结构分析、#乐器识别、#音乐表示学习、#风格迁移、#音乐评估、#舞台技术、#乐谱生成、#音乐推荐、
#音乐去噪、#音乐超分辨

【Methods】
#预训练、#自监督学习、#对比学习、#强化学习、#知识蒸馏、#迁移学习、
#领域适应、#数据增强、#扩散模型、#流匹配、
#Transformer、#GAN、#VAE、#注意力机制、#联邦学习、#提示学习、#指令微调、#模型融合、
#信号处理、#麦克风阵列、#波束成形、#时频分析、#多任务学习

【Attributes / Settings】
#多语言、#零样本、#少样本、#低资源、
#流式处理、#实时处理、#多通道、#在线、#离线、
#对抗样本、#鲁棒性、#模型量化、#高效推理、#长音频处理

【Data / Tools / Evaluation】
#基准测试、#数据集、#开源工具、#模型评估、#模型比较、#数据清洗、#评测协议、#数据隐私

【Domains / Applications】
#音视频、#跨模态、#工业应用、#医疗音频、#智能座舱、#内容审核、#游戏音频、
#声纹识别、#语音驱动、#智能音箱、#助听器、#会议转录

【Naming Conventions】
- Use "语音合成" not "TTS"
- Use "大语言模型" not "LLM"
- Use "多语言" not "多语种"
- Use "音频事件检测" not "声音事件检测"
- Use "自监督学习" not "自监督"
- Use "语音大模型" not "语音LLM" or "LALM"
- Use "流匹配" not "Flow Matching"

## 作者与机构
Please extract author and institution information as completely as possible based on the provided paper content. Requirements:
1. Clearly label the first author (if determinable from the paper), otherwise write "未说明"
2. Clearly label the corresponding author (if determinable from the paper), otherwise write "未说明"
3. List confirmed author names and their affiliations (university, lab, company)
4. Institution information should be as specific as lab or department; if not in the text, write to the highest confirmable level
5. Do not guess institution information; explicitly write "未说明" when unable to confirm

Output format example:
- 第一作者：张三（清华大学计算机系）
- 通讯作者：李四（Google DeepMind）
- 作者列表：张三（清华大学计算机系）、李四（Google DeepMind）、王五（未说明）

## 毒舌点评
Write 2–3 sentences of substantive commentary; must include at least 1 strength and 1 weakness. Can be sharp, but not empty mockery; do not just shout "very strong" or "very weak". Commentary should read like a senior reviewer's final comment — incisive and to the point.

## 核心摘要
Summarize the paper in 5–8 sentences, must cover:
1. What problem it aims to solve
2. What the core method is
3. What is new compared to existing methods
4. What the main experimental results are (include numbers if available; otherwise write "未提供"). If the paper contains experimental result tables, they must be listed in full Markdown table format; if there are experimental result figures, describe the figure content
5. What the practical significance is
6. What the main limitations are

## 方法概述和架构
**Must describe in detail** the paper's core method and its architectural implementation. This section is the technical core of the entire analysis; it must be substantial, clearly structured, and sufficiently detailed.

**Word-count requirement**: the Method Overview and Architecture section must be no fewer than 600 Chinese characters (approximately 400–500 English words equivalent). If the paper's method is complex or has many modules, it should significantly exceed this minimum.

**Required elements (all must be covered)**:
1. **Overall process overview**: describe the complete input → processing → output flow in 2–3 sentences; state whether this is an end-to-end system, multi-stage pipeline, or some framework / methodology.
2. **Main components / modules in detail**: for each core component, explain:
   - **Name**: the formal name used in the paper
   - **Function**: what sub-problem it solves, what responsibility it bears
   - **Internal structure / implementation**: what network architecture is used (e.g., Transformer, CNN, RNN, Diffusion, etc.), what algorithmic principle, what mathematical tools; if the paper provides specific formulas, explain their meaning in words
   - **Input / output**: what data / features it receives, what results it outputs
3. **Data flow and interaction between components**: how are components connected? In what form is data passed? Are there loops / feedback mechanisms? Are there conditional branches?
4. **Key design choices and motivations**: why was this architecture chosen over others? Design trade-offs explicitly mentioned in the paper or reasonably inferable (e.g., accuracy vs. speed, end-to-end vs. modular, self-supervised vs. supervised, etc.)
5. **Multi-stage / multi-module step-by-step expansion**: if the paper's method has multiple stages (e.g., preprocessing → encoding → decoding → post-processing), each stage must be described independently; do not gloss over it
6. **Architecture / flow diagrams**: in the current runtime, the primary deep-analysis round is text-only. Do not insert Markdown image URLs in this prompt. Figure selection and insertion are handled later by the dual-model image-supplement round.
7. **Technical term explanations**: provide necessary explanations for core terms appearing in the method (especially those coined by the paper or domain-specific), so that readers outside the sub-field can understand
8. **Handling non-model work**: if the paper is a dataset, benchmark, theoretical analysis, survey, or other non-model work, focus on describing the method framework, system design, evaluation pipeline, or theoretical derivation process, rather than forcing "model" terminology

**Strictly prohibited**:
- Listing component names only without explaining function and internal structure
- Using "see original paper", "the paper describes the detailed architecture", or other empty phrases in place of concrete description
- Compressing the method overview into 1–2 short paragraphs
- Omitting key components or design details explicitly described in the paper

## 核心创新点
List the 3–5 most important innovations. For each innovation, explain:
- What it is
- What the limitation of previous methods was
- How this innovation works
- What benefit or evidence it brings

## 实验结果
Evidence must be written first; do not just write conclusions. Requirements:
- Provide main benchmark, dataset, metric names, and specific values
- State the gap vs. the strongest baseline or SOTA; if the paper does not directly compare, explicitly state so
- Write key ablation experiments and numerical changes
- Write细分 results under different conditions, languages, or scenarios (if any)
- If there are only figures without text descriptions, still try to convert key numbers into text
- If specific numbers are unavailable, explicitly write "论文未给出具体数值"
- **Experimental result tables must be listed in full using standard Markdown tables** (there may be multiple comparison tables); each table must include headers, model/method names, datasets, metrics, and values; do not omit any rows or columns
- Experimental result figures are not inserted in this primary text prompt. In dual-model mode, `image-supplement.md` selects useful result figures later through a JSON insertion plan, and code merges selected figures plus local lead/explanation text back into the primary analysis.

## 细节详述
Extract all key technical details as much as possible; if missing, explicitly write "未说明":
- Training data: dataset names, sources, scale, preprocessing, data augmentation
- Loss functions: names, roles, weights; explain formula meaning in words when necessary
- Training strategy: learning rate, warmup, batch size, optimizer, training steps / epochs, scheduling strategy
- Key hyperparameters: model size, number of layers, hidden dimensions, codebook size, etc.
- Training hardware: GPU / TPU model, quantity, training duration
- Inference details: decoding strategy, temperature, beam size, streaming settings, etc.
- Regularization or training stabilization tricks

## 评分理由
Please write like a top-tier conference reviewer, scoring and providing specific review comments along the following 8 dimensions. Do not just list scores; explain "why this score" — point out specific strengths and flaws.

**CRITICAL FORMAT REQUIREMENT**:
- Scores MUST use each dimension's own range (e.g., Innovation max is 2, write 1.5 NOT 9.0/10)
- NEVER use 10-point scale, percentage, or any converted score
- Do NOT write total score calculation (code calculates automatically)
- Open Source must match the type-specific core artifact status in `## 开源详情`; code/model/data flags apply to model, dataset, and tool papers, while theory also depends on whether core proofs, derivations, assumptions, and boundaries are fully public in the paper or appendix
- Each defect may be used as a deduction in only one primary dimension
- Apply the evidence standard for `document_type`; the type itself is never a scoring reason

**创新性 (X/2)**
Write specific review comments: novelty of problem / method / insight, key differences from SOTA, whether there is "old wine in new bottles" or incremental improvement, whether the claimed innovation holds up.

**技术严谨性 (X/1.5)**
Write specific review comments: correctness of derivation / proof / algorithm, whether there are flaws, undiscussed boundary conditions, over-simplification, or false assumptions, whether mathematical formulation is rigorous.

**实验充分性 (X/1.5)**
Write specific review comments: whether baselines, ablations, and dataset coverage are sufficient, whether results truly support the conclusions, whether there is over-interpretation of data, whether there is insufficient statistical significance.

**清晰度 (X/1)**
Write specific review comments: writing quality, organization, symbol definitions, figure clarity, whether key details are missing making reproduction impossible, whether the paper is easy to read.

**影响力 (X/1.5)**
Write specific review comments: domain-driving effect, follow-up potential, **relevance to speech / music / audio domain readers**. If the paper achieves SOTA on important benchmarks, releases large-scale datasets / tools, or solves long-standing practical problems in the domain, it should receive a high score — but only if these contributions **directly serve the speech / music / audio domain**. If the paper's core contribution is in computer vision, natural language processing, law / policy, or general machine learning, impact must be low (typically ≤ 0.5), because speech / music / audio readers cannot directly benefit. Narrowly applicable minor improvements or non-audio-core work can only receive low scores.

**开源 (X/1.5)**
Write specific review comments: whether code repository, model weights, dataset, and checkpoints are publicly available. Evaluation dimensions: presence of GitHub link, whether README is provided, whether pre-trained model downloads are available, whether dataset is accessible. Deduct points if only a link is given with no README or documentation.

**可复现性 (X/0.5)**
Write specific review comments: documentation sufficiency beyond open source — training details (learning rate, batch size, optimizer, scheduling strategy), hyperparameter settings, hardware environment, reproduction steps — are they sufficient for others to reproduce without relying on the authors? Deduct points for vague information or missing key details.

**工程/实践价值 (X/1.5)**
Write specific review comments: engineering落地能力, pipeline completeness, practical reference value, industrial reusability. Must be strictly scored for engineering papers (tech reports, system reports, benchmark construction); pure theory research can score 0.

## 局限与问题
Please list the paper's limitations and potential issues like a top-tier conference reviewer. Divide into two parts:
1. **Limitations explicitly acknowledged by the paper**: limitations, future work, and assumption constraints mentioned by the authors themselves, directly quoted or summarized.
2. **Potential issues identified by the reviewer**: possible flaws in the method, possible loopholes in experimental design, whether conclusions are too strong, or any issues the authors did not mention but you as a reviewer feel should be pointed out. If there is no issue in a certain aspect, explicitly write "未发现明显问题".

## 开源详情
Please summarize open-source status based only on information in the paper or links in the provided text; do not fabricate repositories, stars, or platform popularity. Try to cover:
- Code: whether a code repository link is provided; if not, write "论文中未提及代码链接"
- Model weights: whether public weights are mentioned; if not, write "未提及"
- Dataset: whether it is public and how to obtain; if not, write "未提及"
- Demo: whether an online demo is provided; if not, write "未提及"
- Reproduction materials: whether training details, configurations, checkpoints, or appendix explanations are given
- Open-source projects cited in the paper: which dependent open-source tools / models are listed?
- If the paper does not mention it, explicitly state "论文中未提及开源计划"

**Important: output the analysis content directly as requested; do not write any preface, greeting, or confirmation statements (e.g., "好的", "我将", "以下是", "请审阅", etc.), and do not restate task requirements. Output must start from `## 评分`.**
````

## Output Format Notes
This prompt requires the model to output in a strictly fixed structure, containing the following level-1 headings (do not add or remove):
- `## 评分`
- `## 机器摘要`
- `## 标签`
- `## 作者与机构`
- `## 毒舌点评`
- `## 核心摘要`
- `## 方法概述和架构`
- `## 核心创新点`
- `## 实验结果`
- `## 细节详述`
- `## 评分理由`
- `## 局限与问题`
- `## 开源详情`

The code extracts structured data via the `parseAnalysis()` function.

**Image and table placement rules**: tables are embedded directly in the corresponding sections. Images are selected and inserted only by the later `image-supplement.md` round; this prompt must not fabricate or insert image URLs.

**Special character handling rules**:
- Text markers that may appear in papers (e.g., `<S>`, `</S>`, `<E>`, `</E>`, `<s>`, `</s>`, `<e>`, `</e>`, `<interrupt>`, `<backchannel>`, `<response>`, `<task>`, `<perception>`, `<BEsound>`, etc.) **must be wrapped in backticks** as code format, e.g., `` `<S>` ``, `` `<E>` ``, otherwise they will be mis-parsed as HTML tags by the blog system causing rendering errors.
- Mathematical formulas **must be wrapped in `$...$` (inline) or `$$...$$` (block)**; **strictly prohibited to write formulas in plain text**. For example, `RMS = sqrt(1/N Σ y[n]²)` is wrong and must be written as `$RMS = \sqrt{\frac{1}{N} \sum y[n]^2}$`. Special symbols in formulas (e.g., `<`, `>`) that may be mis-parsed as HTML tags should be wrapped in backticks or placed in a formula environment.

**Content completeness rules**:
- Strictly prohibited to output truncated or incomplete sentences. If content is too long, prioritize concise description rather than cutting off mid-sentence.
- All sections must be output completely; stopping in the middle of a section is prohibited.
