# 修正论文分类标签

## 提示词内容

~~~
请依据论文原文，为这篇论文选择词表中已有的概念 ID，纠正分类标签。只选择标签，不改写论文分析正文。

论文标题：{title}
arXiv ID：{arxivId}

当前标签校验错误：{validationFeedback}

论文原文证据：
{textForAnalysis}

当前可用的分类词表：
{tagPromptText}

输出要求

只输出一个 JSON 对象，不加 Markdown 代码块、解释或其他文字。对象恰好包含 `primaryTaskId`、`primaryMethodId` 和 `conceptIds` 三个键。`primaryTaskId` 从词表里选一个状态为 `active` 的 `task.*` ID，要最具体、最贴合这篇论文；`primaryMethodId` 同样选状态为 `active` 的 `method.*` ID，指向论文真正采用的核心方法。

`conceptIds` 包含 3-5 个互不重复、状态为 `active` 的 ID，其中必须有上述主任务和主方法。补充概念可以来自任意分类维度。不要同时选择上下位概念；相关性相当时，优先覆盖不同维度，避免堆叠近义标签。所有标签都要有本篇原文支持。

如何判断任务与方法

测量工具不等于研究任务。社会语音学、韵律统计建模、发音评估挑战或文献综述中，ASR 如果只用于测量而没有产出识别系统，就不能选 `task.asr`，应选 `task.speech-attributes` 或适合的 `scientific_topic`。补充任务也必须有与主任务并列的贡献或评测证据，不能因为使用 WER 等工具就加入相应任务。

分离或提取时，只要用视频、参考音频、说话人嵌入或 DOA 指定目标，就选 `task.target-speaker`；视觉输入可配 `signal.audiovisual`。只有视觉用于盲分离、没有指定目标时，才选 `task.av-speech-separation`。

主方法要落在贡献的核心上。贡献主要在表示、量化、数据或协议时，不选 `method.cnn`、`method.rnn`、`method.transformer`、`method.attention`、`method.state-space` 等骨干架构作为 `primaryMethodId`；这些架构只能作为补充 `conceptIds`。免训练流程或对抗攻击不能因输入多模态就选 `method.multimodal-learning`，它的 `scopeNote` 已区分输入模态与核心方法。应优先考虑 `method.signal-processing` 等系统方法或实际起作用的机制；词表缺项时，选最接近且状态为 `active` 的上位概念。

应用、条件与资源标签

应用场景和实验条件（`application`、`setting`）必须有实际研究证据。只在局限或未来工作中出现的场景不选，`setting.real-time` 还须有实测时延或吞吐及测量条件。标题包含 benchmark/corpus/dataset，或正文明确构造基准、语料时，`conceptIds` 必须包含 `artifact.benchmark` 或 `artifact.dataset`，并优先于泛泛的 `setting`、`model_family` 标签。

三个键的值都必须直接从本篇证据和上方分类词表选择；不要复制任何固定论文示例。
~~~
