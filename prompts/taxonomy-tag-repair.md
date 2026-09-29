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
8. 测量工具不是任务：社会语音学、韵律统计建模、发音评估挑战、文献综述等研究里识别/ASR 只是工具，不产出识别系统，不得选 `task.asr`；改选 `task.speech-attributes` 或合适 `scientific_topic`。
9. 目标条件与盲分离分开：凡用视频、参考音频、说话人嵌入或 DOA 指定目标的分离/提取一律选 `task.target-speaker`（视觉输入可配 `signal.audiovisual`）；只有视觉做盲分离、不指定目标才选 `task.av-speech-separation`。
10. `primaryMethodId` 是贡献核心而非骨干架构：贡献核心为表示、量化、数据或协议时，禁用 `method.cnn`、`method.rnn`、`method.transformer`、`method.attention`、`method.state-space` 等架构 ID，架构只能进补充 `conceptIds`。
11. 免训练管线或对抗攻击方法不得为凑数选 `method.multimodal-learning`（其 scopeNote 明示输入多模态不等于核心方法）；优先 `method.signal-processing` 等系统类或实际起作用的机制，词表缺项时选最接近的 active 上位概念。
12. application/setting 需正面证据：只在局限或未来工作出现的应用场景不得选；`setting.real-time` 必须有实测时延/吞吐与测量条件支撑。
13. 标题含 benchmark/corpus/dataset 或正文写明构造基准、构建语料的，`conceptIds` 必须携带 `artifact.benchmark` 或 `artifact.dataset`，其优先级高于泛化 `setting`/`model_family`。
14. 次任务克制：补充 task 只在与主任务有并列贡献或并列评测证据时选择；把某任务仅当评测工具（如用 WER 评测）不得作为补充 task。

三个键的值都必须直接从本篇证据和上方投影选择；不要复制任何固定论文示例。
~~~
