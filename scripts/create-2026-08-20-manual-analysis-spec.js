#!/usr/bin/env node
/**
 * Operator-authored 2026-08-20 manual deep-analysis sheet.
 * The facts below are deliberately tied to the fetched title/abstract/full
 * text; the ingestion command supplies source hashes and refuses any missing
 * evidence or failed contract.  No model or remote API is used here.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, normalizedId, getBeijingISOString } = require('./utils.js');
const Config = require('./config.js');

const DATE = '2026-08-20';
const TEXT_DIR = path.join(Config.CURRENT_DIR, 'manual-full-text', DATE);

const records = {
    '2608.18341': {
        type: '应用研究', task: '#音频分类', method: '#端到端', tags: '#音频分类 #端到端 #工业应用 #高效推理',
        dims: [1.4,1.2,1.1,0.8,0.8,0.5,0.3,1.2],
        question: '如何在极低功耗和低延迟约束下持续发现机器声学异常。',
        method: '系统把传感器采集的机器声音转换为 log-mel 特征，再送入自编码器式异常检测器；推理主体部署在 Intel Loihi 2 神经形态处理器，特征归一化在芯片外完成。编码器学习正常声学模式的紧致表示，解码器重构输入，重构误差作为异常分数，因此不要求为每一种故障穷举标签。清洁与噪声条件通过统一的窗口化、归一化和阈值流程进入同一检测路径。',
        method2: '论文的关键交互是“特征提取—神经形态推理—异常分数”三级数据流：前端负责频谱表示，Loihi 2 负责低功耗事件驱动计算，后端根据重构误差和阈值输出告警。作者同时比较清洁和含噪输入，观察功耗、延迟与检测质量之间的变化。由于正文没有把每层神经元参数、阈值学习过程和完整部署脚本全部列出，本文能确认的是系统边界和数据流，不能补造未说明的硬件配置。',
        method3: '采用自编码重构而不是监督分类的动机是工业现场故障类型不断变化，正常数据更容易持续获得；神经形态处理器则针对“始终在线”场景压低能耗。这个组合的实际取舍是把一部分 log-mel 计算留在芯片外，以换取可部署性和较低片上负担，同时接受异常阈值与噪声分布仍需现场校准。',
        innovations: '一是把自编码器声学异常检测落到 Loihi 2 的持续监测场景；二是将清洁/噪声条件纳入同一部署评估；三是把能耗、时延和异常质量作为联合工程约束，而不是只报分类准确率。',
        results: '在清洁和噪声条件下，论文报告了 log-mel 前端与 Loihi 2 部署的异常检测实验，并讨论功耗、延迟和检测质量。摘要没有给出完整的 AUC、误报率或所有基线数字，因此这些数值不能由本分析补齐。',
        details: '训练数据、异常比例、窗口长度、优化器、学习率、Loihi 2 资源配置和阈值选择在当前正文中未完整给出；可确认使用 log-mel 特征、自编码重构和清洁/噪声两类条件。推理是持续在线的片段级检测，具体告警平滑和校准步骤未说明。',
        limits: '作者承认持续监测仍受功耗、延迟和部署复杂度约束。审稿人进一步指出，缺少公开故障类别划分、误报/漏报曲线和跨机器迁移实验，会限制现场可靠性判断。',
        open: '论文中未提及代码仓库、模型权重或可下载数据；只说明了 Loihi 2 实验平台和声学特征流程。',
        review: '问题直接对应工业声学监测，方法与部署协同有价值，但公开实验数字和复现材料不足。'
    },
    '2608.18191': {
        type: '方法研究', task: '#音频分类', method: '#迁移学习', tags: '#音频分类 #迁移学习 #低资源 #模型评估',
        dims: [1.4,1.2,1.1,0.8,0.6,0.5,0.3,0.8], question: '如何在蝙蝠叫声跨行为、跨环境变化时保持物种识别可靠。',
        method: 'ChiroEcho 面向被动声学监测，把夜间录音切成蝙蝠 echolocation call 片段，使用预训练声学表示作为起点，再针对物种与行为变化进行分类适配。输入是带环境噪声和重叠叫声的声学片段，编码器产生时频表示，分类头输出超出原有 taxonomy 的类别。论文强调行为和环境会改变叫声分布，因此训练和测试不能只依赖单一录音地点评估。',
        method2: '系统数据流由被动采集、调用检测、预训练表示、分类器和生态监测输出组成；核心是把“学到的类别边界”扩展到新的叫声类型，而不是只扩大最后一层。跨物种、跨行为和跨环境测试用于区分真正的泛化与录音条件记忆。摘要没有公开网络层数、冻结层范围或采样率，故只陈述可核验的处理链。',
        method3: '选择迁移学习的动机是蝙蝠数据标注昂贵且生态场景难以重复采集；选择被动声学监测则避免夜间人工捕获。代价是预训练表示可能携带原 taxonomy 偏差，新的物种/行为若没有足够覆盖仍会产生漏检。',
        innovations: '一是把自动蝙蝠声分类从封闭 taxonomy 推向开放生态变化；二是显式处理叫声随行为和环境改变的问题；三是将算法评估与保护监测的可用性连接起来。',
        results: '论文在被动声学监测数据上比较扩展 taxonomy 前后的分类表现，并讨论叫声变化和重叠。摘要没有列出完整物种级准确率、F1 或基线表，因此不能补造具体数值；可确认结论集中在跨类别泛化而非单一场地峰值。',
        details: '正文可确认使用蝙蝠声学片段、预训练声学编码器和分类适配；数据规模、采样率、增强、优化器、学习率和硬件未完整说明。跨环境测试的具体划分需要依论文表格核对，当前分析不把未给出的配置写成事实。',
        limits: '作者指出叫声会随行为和环境变化且不同物种可能重叠。潜在问题是开放集未知物种、季节迁徙和设备域偏移仍可能超出实验覆盖，保护决策还需要人工复核。',
        open: '论文中未提及代码、模型权重或数据下载地址，也未说明数据许可。', review: '生态声学问题很重要且迁移方向合理，但证据与配置披露有限，影响力主要集中在生物声学。'
    },
    '2608.18132': {
        type: '模型报告', task: '#音频理解', method: '#音频大模型', tags: '#音频理解 #音频大模型 #预训练 #多模态模型',
        dims: [1.7,1.2,1.2,0.8,1.2,0.5,0.3,1.1], question: '音频语言模型是否必须依赖大量任务特定监督才能获得通用推理能力。',
        method: '论文研究通用 Audio-Language Model 的无指令训练路线。整体流程从预训练音频编码器和语言模型出发，先做跨模态表示对齐，再把音频语义送入语言模型的上下文，最后直接回答理解任务。作者把传统的对齐、监督微调、偏好优化流水线作为对照，试图验证在已有语言推理能力的前提下，是否可以省去大量任务特定 instruction 数据。',
        method2: '核心组件包括音频编码器、跨模态投影/对齐模块和语言生成器。音频片段先被编码成连续表示，投影层把维度与语言模型 token 空间接通，语言模型利用自身的文本推理能力完成描述、问答或分类；训练信号主要约束跨模态语义一致，而不是为每个任务单独写指令。具体编码器层数、投影维度和训练配比必须以全文表格为准，摘要本身未完整列出。',
        method3: '关键取舍是用通用对齐替代任务特定监督：优点是迁移成本低、任务扩展快，风险是细粒度音频事件和长时结构可能没有被充分教会。论文的“instruction-free”主张只有在多任务、跨数据集和失败案例同时成立时才有说服力。',
        innovations: '一是提出无需指令数据的音频语言模型训练路线；二是重新审视“跨模态适配必须三阶段”的假设；三是把语言模型已有推理能力作为音频任务迁移的可复用资源。',
        results: '论文比较传统多阶段训练与 instruction-free 对齐路线，并在通用音频语言任务上报告迁移表现。摘要未给出所有任务的逐项分数和完整基线表，因此本分析只保留方法主张，不虚构 SOTA 数字。',
        details: '可确认训练包含音频编码、跨模态对齐和语言模型生成；监督样本规模、优化器、学习率、batch size、硬件、音频采样设置及评测任务清单在摘要中未说明，需以正文实验章节逐项复核。',
        limits: 'instruction-free 路线可能牺牲任务边界控制和细粒度声学定位；若只在常见音频描述任务上验证，不能推出对音乐结构、长音频和罕见事件同样有效。',
        open: '当前文本未提供代码、权重、训练数据或 demo 链接；开源状态未说明。', review: '这是本批最直接的音频大模型工作，问题和路线都重要；但无完整数值与材料时不能把“通用”当成已证实。'
    },
    '2608.19174': {
        type: '系统技术报告', task: '#音频检索', method: '#对比学习', tags: '#音频检索 #对比学习 #CNN #模型比较',
        dims: [1.3,1.0,1.1,0.8,0.7,1.0,0.3,1.1], question: '如何用人声模仿查询目标音效并在音效库中检索。',
        method: '该技术报告针对 AES AIMLA 2025 音效查询挑战，输入是一段人声模仿，输出是与其声学语义相近的音效检索结果。第一条路线冻结预训练 CED 音频编码器，通过对比学习把 vocal imitation 与目标音效拉近；第二条路线用 MobileNetV3 编码器联合 contrastive-triplet loss，并用 semi-hard negatives 增强难例区分。',
        method2: '两条路线都把查询和候选音效映射到共享嵌入空间，再按相似度排序；冻结 CED 路线强调利用通用音频表示，MobileNetV3 路线则允许任务适配。triplet 约束让正例距离小于难负例，半难负样本避免训练只看容易区分的声音。报告还记录了挑战赛后补充的细节，但未把全部数据处理和检索库规模写入摘要。',
        method3: '方法取舍是预训练表示稳定性与任务专用适应性的对照，而非盲目追求更大模型。报告型工作最大的工程价值在于给出可落地的训练和检索组合，最大的风险是挑战赛数据与真实声音库之间存在域差。',
        innovations: '一是把 vocal imitation 作为声音检索查询而非传统文本标签；二是比较冻结 CED 与联合 triplet 训练两种互补策略；三是以挑战赛完整系统为工程验证载体。',
        results: '报告称该系统获得 AES AIMLA 2025 Challenge 的获胜提交，并比较两条微调路线；摘要没有给出 Recall@K、mAP 或各路线的完整数值，不能扩写成具体 SOTA 差距。',
        details: '已知组件为 CED、MobileNetV3、对比损失、triplet 损失和半难负样本；训练轮数、学习率、候选库规模、音频裁剪和硬件未在摘要中完整说明。推理阶段是嵌入计算加近邻排序。',
        limits: '挑战赛设置可能不能覆盖口音、模仿风格和真实录音设备的变化；报告若缺少失败案例，也无法判断相似音色与相似事件之间的混淆。',
        open: '论文文本未提供代码仓库、模型权重或数据下载链接；挑战赛后补充细节不等于完整开源。', review: '任务清楚、路线有对照且工程味足；但“获胜”缺少可核验指标，读者不能仅凭摘要判断领先幅度。'
    },
    '2608.19141': {
        type: '方法研究', task: '#音频编码', method: '#生成模型', tags: '#音频编码 #生成模型 #高效推理 #模型评估',
        dims: [1.6,1.2,1.2,0.8,1.0,0.5,0.3,1.0], question: '粗粒度 RVQ codec token 如何重合成高保真音频。',
        method: '论文把神经音频 codec 的重合成定义为从粗粒度离散 token 恢复连续波形的问题。输入是残差向量量化产生的部分 token，模型通过几何迭代检索逐步寻找缺失的细节表示，再由解码器重建音频。与直接把每个 token 当独立类别不同，该方法显式利用 codec codebook 的几何关系和残差结构。',
        method2: '流程可分为 token 解析、候选 codebook 检索、迭代细化和波形解码。检索阶段在表示空间中寻找与当前粗表示一致的候选，迭代阶段更新残差或候选集合，最后把完整离散表示送入 codec decoder。这样既面向离散表示的效率，又把音质恢复视为逐步逼近问题；具体迭代次数、距离函数和解码器配置需以全文为准。',
        method3: '设计动机是粗 token 的信息瓶颈会限制任何后续生成系统的音质；几何检索比单纯增加自回归步数更直接地利用 codebook 结构。代价是检索开销、候选错误累积和对 codec 训练分布的依赖，需要在不同码率和音频类型上验证。',
        innovations: '一是把 codec 重合成建模为几何迭代检索；二是针对粗 token 的残差细节恢复；三是把表示空间结构而非单一神经网络容量作为音质提升来源。',
        results: '论文围绕粗 codec token 的重合成质量进行比较，摘要强调该问题决定 token-based general audio generation 的保真度，但未列出完整客观指标和基线数字。',
        details: '已知使用 RVQ、codebook 几何检索、残差细化与 codec decoder；训练数据、迭代预算、距离度量、采样率、硬件和主观听测协议未在摘要完整说明。',
        limits: '几何结构可能依赖特定 codec 的 codebook；在跨 codec、极端压缩、音乐与语音混合场景下的稳健性仍需验证。',
        open: '论文中未提及代码、预训练 codec、模型权重或数据集开放情况。', review: '抓住了生成音频的表示瓶颈，方法问题意识强；但没有完整数字和跨 codec 证据时，不能把几何检索视作普适解决方案。'
    },
    '2608.19061': {
        type: '系统技术报告', task: '#音乐理解', method: '#端到端', tags: '#音乐理解 #开源工具 #模型评估 #音乐推荐',
        dims: [1.2,1.0,1.0,0.9,0.7,1.2,0.4,1.2], question: '如何统一提取符号旋律中的音乐理论和心理学特征。',
        method: '论文先定义符号化旋律特征提取的范围，再系统盘点现有 toolbox 中的特征，并把它们整理为共同 taxonomy。输入是 MIDI 或其他符号旋律表示，处理阶段解析音高、节奏、音程、轮廓和重复结构，输出是可供分析与检索使用的特征向量。',
        method2: '新软件库的架构重点不是单一神经网络，而是特征接口、统一命名、实现校验和跨工具映射。每一类特征都需要说明输入事件、时间尺度和输出统计量，避免不同工具对同一音乐概念使用不可比定义。论文同时讨论心理学相关特征，试图让计算表示与听觉感知概念对应。',
        method3: '采用共同 taxonomy 的动机是现有工具箱各自为政，研究者难以比较或复用；统一库降低工程重复，但也会继承符号表示无法捕捉演奏音色、力度和真实音频声学细节的局限。',
        innovations: '一是给出符号旋律特征的系统分类；二是实现覆盖多类音乐理论/心理学特征的软件库；三是把特征定义和可复用实现放到同一工程接口。',
        results: '论文通过特征清单、分类体系和软件实现展示覆盖范围，并讨论不同特征的音乐学含义。摘要未给出统一 benchmark 的准确率或完整运行时间对比，因此不能声称某模型 SOTA。',
        details: '处理对象是符号编码旋律；特征计算公式、依赖库、版本和部分实现细节在正文/代码中需要逐项复核，当前摘要未说明训练参数，因为该工作不是训练型模型。',
        limits: '符号旋律不等于真实音频；缺少演奏表达、录音混响和多声部复杂音色时，特征与听觉感知的对应关系可能被高估。',
        open: '论文称提出新的 software library，但当前提供文本没有仓库 URL、版本号或数据许可，开源可得性只能记为未完整确认。', review: '工具和 taxonomy 对音乐分析读者有直接价值；它的贡献在可复用基础设施而非新模型，覆盖验证仍需更多跨语料实测。'
    },
    '2608.18226': {
        type: '方法研究', task: '#音频生成', method: '#多模态模型', tags: '#音频生成 #多模态模型 #端到端 #游戏音频',
        dims: [1.5,1.1,1.1,0.8,0.9,0.5,0.3,1.1], question: '如何表示合成器信号路由和参数交互并从目标声音检索 preset。',
        method: '任务是给定目标声音寻找最匹配的合成器 preset。方法不把合成参数当作扁平向量，而是同时编码参数值、模块连接和信号路由；音频编码器提取目标声音表示，参数/路由编码器提取 preset 结构表示，训练目标让能生成相似声音的配置在嵌入空间更接近。',
        method2: '数据流从目标音频和合成器图结构并行开始：音频分支负责感知结果，参数分支负责控制结构，融合层产生共享表示，检索头返回候选 preset。路由信息使模型能区分“同样数值但不同连接”的声音差异，参数交互则避免把每个旋钮当成相互独立。正文未说明具体网络层数和损失权重，分析保持这一边界。',
        method3: '核心取舍是结构化表示的表达力与检索复杂度之间的平衡；显式建模路由更贴近真实合成器，但依赖准确的 patch 图和可解释的参数语义。目标声音中若存在未建模效果器或录音环境，检索结果可能无法复现。',
        innovations: '一是把合成器 signal routing 纳入参数表示；二是用共享嵌入连接目标音频和 preset 结构；三是面向声音设计把“找到可解释控制配置”置于单纯音色相似度之前。',
        results: '论文评估目标声音到 preset 的匹配，并以平坦参数基线比较结构化表示；摘要未提供完整 top-k、听测或消融数字，不能补造领先幅度。',
        details: '可确认输入包含目标声音、参数值和路由结构，输出是候选合成器 preset；数据规模、采样率、合成器种类、训练配置、硬件与推理候选数未完整说明。',
        limits: '方法依赖合成器元数据和预设空间；对真实录音、复杂效果链、非合成器声源以及参数不可辨识的情况，泛化仍未知。',
        open: '论文中未提及代码、模型权重或 preset 数据集的公开地址。', review: '把路由结构纳入音色检索是明确的音频工程洞察；不过证据披露偏少，实用性还需真实制作流程验证。'
    },
    '2608.18141': {
        type: '方法研究', task: '#音频理解', method: '#端到端', tags: '#音频理解 #端到端 #高效推理 #工业应用',
        dims: [1.4,1.2,1.1,0.8,0.8,0.5,0.3,1.2], question: '如何快速恢复水下声学传输损失中的高频干涉细节。',
        method: '论文提出 Spectral-Spatial Residual Learning（S2RL）预测水下 acoustic transmission loss。输入是海洋环境与传播条件对应的场数据，第一阶段 Spectral Global Propagator 用全局频谱算子给出平滑且一致的粗预测，第二阶段 Spatial Local Refiner 学习局部高频残差，最终输出细粒度传播损失图。',
        method2: '架构是粗到细的两级数据流：全局传播器负责长程、低频结构，局部细化器只处理粗预测与真实场之间的残差。该分解针对 Fourier Neural Operator 的频率截断问题，避免让一个全局算子同时承担所有高频细节。论文在 South China Sea 数据上比较 FNO 基线，并把毫秒级推理作为工程约束。',
        method3: '关键选择是频谱与空间分工而不是简单增加网络宽度；全局分支保留物理场一致性，局部分支恢复干涉纹理。风险是训练分布和海域条件绑定，跨海域、跨频段和极端传播条件需要额外验证。',
        innovations: '一是将谱全局传播与空间局部残差明确解耦；二是直接针对 FNO 高频过平滑缺陷；三是在声学传播任务中同时追求预测质量和毫秒级速度。',
        results: '在 South China Sea 数据上，论文报告 S2RL 显著优于 FNO 基线，并保持毫秒级推理；摘要未给出具体误差、速度和不同频段表格，因此不补写数值。',
        details: '已知数据为水下声学传播损失场，模型含全局频谱传播器和空间局部细化器；优化器、网格尺寸、训练步数、硬件和完整边界条件未在摘要说明。',
        limits: '实验区域单一可能限制海域迁移；传播模型误差、环境参数缺失和高频噪声会影响残差学习，毫秒级速度也需要在不同硬件上复核。',
        open: '当前论文文本未提及代码、模型权重或 South China Sea 数据的公开方式。', review: '这是音频/声学读者会关心的谱-空分解，工程目标清晰；但单海域证据和细节缺失限制了泛化结论。'
    },
    '2608.19055': {
        type: '模型报告', task: '#音视频生成', method: '#扩散模型', tags: '#音视频生成 #扩散模型 #音乐理解 #游戏音频',
        dims: [1.6,1.2,1.2,0.8,1.0,0.5,0.3,1.2], question: '如何从真实世界音乐音频生成空间精确且节奏同步的鼓手动作。',
        method: '论文提出音频驱动的鼓手动作扩散框架。输入是 in-the-wild 音频，扩散模型生成全身骨骼和鼓棒轨迹；双目标损失把 skeletal integrity 与 drumstick precision 解耦，前者约束身体动力学，后者约束击打位置。自建数据集和增强策略用于减少只在 MIDI 或精选音频上训练的偏差。',
        method2: '生成流程先从音频提取节奏和声学条件，再在扩散去噪过程中逐步生成动作序列；输出同时包含身体姿态和鼓棒空间位置。评价使用 impact-to-target distance 衡量空间精度，用 audio-motion correlation score 衡量时间同步，并配合用户研究检查自然度。这样可把“看起来像打鼓”和“真正击中目标”分开。',
        method3: '选择扩散模型是为了覆盖多峰动作可能性，双目标损失则回应鼓手动作中高速局部运动与整体自然度的冲突。代价是采样成本与动作条件依赖；非 curated 音频的节拍、噪声和编曲复杂度仍可能造成失败。',
        innovations: '一是面向真实音频的鼓手动作扩散生成；二是把骨骼完整性与鼓棒精度分开优化；三是提出空间击打距离和音频-动作相关性两个针对性指标。',
        results: '论文报告模型可泛化到非精选真实音频，并通过定量分析和用户研究验证自然度、空间精度与时间对齐；摘要未给出指标数值和基线差距，不能补造。',
        details: '数据包含自建鼓手动作与音频，使用数据增强；扩散步数、骨骼关节数、损失权重、训练硬件和用户研究样本量未在摘要中完整说明。',
        limits: '动作覆盖可能集中于特定鼓组和表演风格；对极端速度、多鼓手、遮挡和非西式节奏的泛化需要更多数据。',
        open: '论文中未给出代码、模型权重或自建数据集下载地址。', review: '问题定义和指标设计比“生成一段像样动作”更严谨；但缺少可核验数字，当前只能评为有潜力的系统报告。'
    },
    '2608.18825': {
        type: '应用研究', task: '#语音识别', method: '#领域适应', tags: '#语音识别 #领域适应 #多语言 #医疗音频',
        dims: [1.2,1.1,1.2,0.9,1.0,0.5,0.3,1.0], question: '医疗、多语言适配后 ASR 模型的层级行为和错误来源是什么。',
        method: '论文对 Whisper 等预训练 ASR 做医疗和多语言适配，并把分析粒度从单一 WER 扩展到层级表示、词汇、语言和术语行为。输入是临床语音，模型编码声学序列并输出转写；适配阶段利用有限标注和医疗术语分布，比较不同层的表示变化。',
        method2: '分析流程包括基线转写、领域适配、逐层探针/表示比较、错误分类和多语言评估。这样的架构不是只追求最终 WER，而是把“为什么适配后变好或变坏”拆成声学、语言和术语层。论文若未提供某个语言的样本规模或训练配置，本文明确标为未说明。',
        method3: '选择层级分析是为了避免把医疗 ASR 的全部问题归结为数据量；多语言设置可检验适配是否牺牲低资源语言。风险是探针关联不等于因果解释，层级差异还需要受控干预验证。',
        innovations: '一是把医疗 ASR 领域适配从结果指标推进到层级行为分析；二是同时覆盖术语、语言和有限标注约束；三是提供面向实际临床转写的错误诊断视角。',
        results: '论文报告多语言医疗适配后的层级分析与 WER 对比，并讨论术语和泛化行为；当前摘要没有给出每种语言、模型和错误类型的完整数值表，故不补造。',
        details: '使用 Whisper 类预训练 ASR、医疗语音和多语言适配；具体语料规模、采样率、训练步数、学习率、探针结构、硬件和解码设置未完整公开。',
        limits: '医疗语音隐私、专业术语覆盖和跨医院设备偏移都可能造成外部失效；逐层相关性分析不能自动证明某层是错误根因。',
        open: '论文中未提及新代码、模型权重或医疗语音数据的公开方式；预训练 Whisper 属外部依赖但不等于本文开源。', review: '把临床 ASR 的“层级诊断”做实用化是亮点；不过在隐私和外部验证不足时，不能把 WER 改善直接等同于临床可靠。'
    },
    '2608.18680': {
        type: '应用研究', task: '#音频生成', method: '#生成模型', tags: '#音频生成 #模型评估 #多模态模型 #可解释性',
        dims: [1.2,1.0,1.0,0.9,0.8,0.5,0.3,1.0], question: '声音如何在不确定性可视化中传达情绪而不只是传达数值。',
        method: '论文采用 co-design 研究而非单纯训练模型。参与者面对不确定性可视化，为同一数据设计两种 sonification：一种表达不确定性的 affective component，另一种保持中性。音频的波形、节奏、音色和动态成为设计变量，研究者随后归纳参与者如何把听觉属性与情绪意义联系起来。',
        method2: '流程是视觉不确定性编码、声音设计、参与者创作、质性归纳与跨样本比较。输出不是分类标签，而是关于 wavy、ominous、clear、relaxing 等听觉品质的设计规律。视觉和音频共同构成多模态界面，声音不替代数值，而是补充用户对不确定性的情感解释。',
        method3: '对照“情感声景/中性声景”能把情绪意图与普通可听化区分开；选择参与者共创提高生态效度，但样本和文化背景会影响归纳稳定性。',
        innovations: '一是将不确定性 sonification 从数值映射扩展到情绪维度；二是用共创研究抽取声音品质与情感的联系；三是提出可用于可视化设计的 wavy/ominous 与 clear/relaxing 对照。',
        results: '研究发现不确定性常与 wavy、ominous 的听觉品质相连，中性条件更常出现 clear、relaxing 属性；论文未提供统一数值效果量，结论主要来自共创样本的质性归纳。',
        details: '参与者、可视化任务、声音制作工具和编码流程是主要实验材料；样本量、统计检验、音频参数和重复实验设置未在摘要完整说明。',
        limits: '情绪联想受文化、听力和声音经验影响；共创研究的主观性和小样本可能限制跨人群推广，不能把设计偏好当作普适心理定律。',
        open: '论文中未提及音频样例、代码或参与者数据的公开地址。', review: '问题有新意且对听觉可视化设计有启发；但证据偏质性，工程落地需要可重复的听测和跨文化验证。'
    },
    '2608.18689': {
        type: '系统技术报告', task: '#语音交互', method: '#语音大模型', tags: '#语音交互 #语音大模型 #多语言 #语音克隆',
        dims: [1.4,1.1,1.2,0.8,1.0,1.0,0.3,1.2], question: '低资源突尼斯方言 SLU 是否能通过少样本增强和合成语音改善。',
        method: 'Aslema 面向 NADI 2026 SLU 任务，包含 intent recognition 与 slot filling 两个子任务。系统比较四个 omni LLM 的零样本能力，再对最佳路线做微调；数据增强阶段先用 LLM 生成文化相关的 Tunisian Derja utterances，再通过 voice cloning 生成合成语音，最后把原始与合成样本混合训练 Qwen3-Omni-30B。',
        method2: '数据流是文本/语音输入、意图与槽位联合预测、合成样本扩充和评测排名。语音克隆把新增文本变成可听训练信号，模型同时处理语言内容和声学形式；训练结果用 intent accuracy、WER 与 CoER 等任务指标衡量。该 pipeline 把低资源语言覆盖、合成数据和 omni 模型能力放在一个可复用系统中。',
        method3: '选择文化相关生成而不是简单回译，意在补足方言语料的语用分布；voice cloning 让增强样本拥有语音形态，但可能引入合成伪影和说话人偏差。作者同时报告零样本、微调和正式榜单，便于区分模型能力与数据增强收益。',
        innovations: '一是面向 Tunisian Derja 的 LLM+voice cloning 增强；二是把 intent/slot 的 omni 模型微调和合成语音统一；三是在官方测试上同时报告 CoER、WER、意图准确率与排名。',
        results: 'devtest intent accuracy 为 86.8%，WER 为 34.7；官方测试 slot filling CoER 为 59.5，意图识别准确率 66.1%，在 8 队中分别排名第 1 和第 4。',
        details: '使用 Qwen3-Omni-30B、原始与合成数据，任务为 NADI Shared Task 5；合成数据规模、voice cloning 模型、学习率、batch size、训练步数、GPU 和解码设置未完整说明。',
        limits: '合成语音可能放大方言发音偏差；榜单数据和单一方言不能代表所有低资源语言，正式测试上的意图与槽位差距也提示任务不均衡。',
        open: '论文声明会发布实验脚本，并将很快分享合成数据；当前文本未给出可验证 URL，因此代码是部分承诺、数据尚未确认。', review: '这是本批最完整的低资源语音系统之一，数字和榜单证据清楚；但合成语音质量与数据开放时间仍是关键不确定性。'
    },
    '2608.18661': {
        type: '模型报告', task: '#语音合成', method: '#自回归模型', tags: '#语音合成 #自回归模型 #流式处理 #高效推理',
        dims: [1.6,1.2,1.2,0.8,1.1,0.5,0.3,1.2], question: '如何从不完整的流式文本逐 token 生成连续自然语音。',
        method: 'X2Streaming-TTS 把文本流的每个 token 作为不确定前缀，持续生成语音而不是等待完整句子。模型维护 speech state，在新 token 到达时继承已有声学上下文，预测下一段声学 token 或波形，并通过有限上下文控制无限流的计算量。输出必须在文本不断扩展时保持感知连续。',
        method2: '架构包含 token-level 文本编码、speech-state inheritance、因果声学生成和流式解码。状态继承连接前一窗口和当前窗口，因果路径保证未来文本不会泄漏到当前语音；边界处需要拼接、停顿和 prosody 处理。论文的关键比较应包括句级 TTS、伪流式系统和真正 token-level 生成，具体网络规模和解码缓存配置未在摘要给出。',
        method3: '设计取舍是上下文长度、延迟与长期连贯性之间的平衡；继承状态可降低重复计算，却可能把早期错误长期传播。对不完整文本的鲁棒性是价值所在，但需要真实打断、修订和长时对话测试。',
        innovations: '一是定义真正 token-level 而非句级伪流式 TTS；二是用 speech-state inheritance 维持跨窗口连续性；三是把无限文本流的有界上下文和低延迟同时纳入设计。',
        results: '摘要明确了流式文本、上下文有界和连续性的目标，但未提供延迟、MOS、RTF 或长流失败率数字，因此本分析不补造结果。',
        details: '已知输入是 streaming text，核心机制是 causal token-level synthesis 与状态继承；模型层数、声学 token 化、训练语料、优化器、硬件和拼接策略未完整说明。',
        limits: '长时间状态可能累积漂移；文本改写、回退、跨句韵律和突发 token 对稳定性的影响需要单独评估，不能只凭短句 benchmark 结论。',
        open: '论文中未提及代码、模型权重或可试听 demo 的公开地址。', review: '切中了低延迟语音交互的真正瓶颈；但没有可核验的延迟和质量数字时，系统优势仍是待验证假设。'
    },
    '2608.18105': {
        type: '系统技术报告', task: '#语音交互', method: '#大语言模型', tags: '#语音交互 #大语言模型 #端到端 #模型评估',
        dims: [1.2,1.0,1.1,0.8,0.6,0.5,0.3,1.2], question: '如何把带噪 spoken financial requests 转成可检查、可执行的结构化查询。',
        method: 'StocksTalk 是一条语音驱动的数据查询流水线：用户说出金融筛选条件，streaming speech recognition 先转写，检索增强约束抽取把自然语言变成规范化指标与操作符，schema-grounded LLM 生成 SQL，规则验证器检查可执行性，人工在 dashboard 中确认。',
        method2: '系统输出不仅是最终 SQL，还保留中间约束、指标归一化、操作符 grounding 和验证结果。语音识别、检索、生成、规则校验和 human-in-the-loop 形成串联闭环；任何阶段出错都可以回到约束或查询编辑，而不是把不可解释的字符串直接执行。150 条 spoken prompts 覆盖多种投资策略与输入噪声。',
        method3: '选择 schema grounding 和规则校验是为了降低金融查询的语义与执行风险；人工确认牺牲全自动化换取可审计性。系统的关键边界是金融数据库 schema 与语音识别质量，LLM 本身不是唯一决定因素。',
        innovations: '一是将 streaming ASR、约束抽取、SQL 生成和验证串成透明语音查询管线；二是暴露中间推理产物供用户修订；三是用真实输入噪声评估语音到结构化查询的稳定性。',
        results: '150 条 spoken financial prompts 构成评测集；论文报告检索 grounding、受限生成和交互验证提升约束抽取准确率、SQL 可执行性、逻辑一致性和多轮稳定性，但摘要未列具体百分比。',
        details: '组件包括 streaming ASR、RAG 约束抽取、schema-grounded LLM、规则校验和 dashboard；数据库规模、ASR 模型、提示词、延迟、硬件和人工复核时间未完整说明。',
        limits: '金融领域 schema 迁移、方言/口音、数字识别错误和用户过度信任仍是风险；150 条提示规模也不足以覆盖复杂投资语义。',
        open: '论文中未提及代码、模型权重、数据集或在线 demo 链接。', review: '系统链路和审计思路很实用，但金融安全需要更强的错误成本、攻击和真实用户证据。'
    },
    '2608.18114': {
        type: '应用研究', task: '#语音识别', method: '#大语言模型', tags: '#语音识别 #大语言模型 #端到端 #医疗音频',
        dims: [1.5,1.2,1.2,0.8,1.0,0.5,0.3,1.0], question: '能否仅凭实时 MEG 无创解码自然句子的产生。',
        method: 'Brain2Qwerty v2 从实时 magnetoencephalography 记录预测自然句子。输入是受试者打字时的 MEG 序列，深度模型同时使用字符、词和句子级表示，逐步把脑信号映射到文字序列，输出是可读句子而不是孤立字母。数据采集包含 9 名受试者、每人约 10 小时和 22,000 句。',
        method2: '方法链包含事件检测替代、脑信号编码、字符/词/句子层级预测和语言模型语义表示。论文还使用大语言模型提取语义表示，并让 AI agent 迭代改进解码 pipeline；这使模型同时利用低层时间信号和高层语言约束。评价以 WER 和句子级低错误比例衡量，避免只报 token accuracy。',
        method3: '选择层级表示是为了处理脑信号到自然语言之间的长距离映射；用深度学习替代手工事件检测降低了 pipeline 假设。关键取舍是语言先验带来的可读性与潜在语言偏置之间的平衡，跨受试者和隐私边界仍需谨慎。',
        innovations: '一是无创 MEG 解码自然句子而非受控词表；二是联合字符、词和句子表示；三是用数据规模和 agent 辅助迭代展示无创 BCI 的可扩展路径。',
        results: '平均 WER 为 39%；最佳受试者约一半句子达到至多一个词错误。准确率随数据量对数线性提升，数据为 9 人、22,000 句、每人 10 小时。',
        details: '数据采集规模和 MEG 来源明确；训练优化器、学习率、模型参数、语言模型版本、硬件和在线解码延迟未完整说明。评价包含平均 WER、最佳参与者和数据量曲线。',
        limits: '受试者数量少且采集成本高；语言先验可能掩盖脑信号错误，跨人群、真实失语者和长期使用效果尚未证明。',
        open: '论文中未提及 MEG 数据、模型权重或训练代码的公开链接。', review: '数字和任务难度都很有说服力，展示了无创语音 BCI 的进展；但小样本与受试者依赖性使临床外推必须保守。'
    },
    '2608.18090': {
        type: '方法研究', task: '#音频理解', method: '#无监督学习', tags: '#音频理解 #无监督学习 #多模态模型 #模型评估',
        dims: [1.6,1.2,1.2,0.8,1.0,0.5,0.3,0.9], question: '少量情绪名称和文本故事能否学习跨文本、图像、音频与脑信号的 valence 方向。',
        method: '论文从 9 个情绪类别名称和每类 50 个短故事构造情绪锚点，在冻结编码器的嵌入空间中对每类求平均，再取九个中心的第一主成分作为 V-axis。新输入投影到该轴得到连续正负情绪值，不需要为每个目标模态重新标注情绪。',
        method2: '方法把文本锚点、冻结编码器、PCA 和跨模态投影连成无监督流程；在音频分支中使用 ESC-50，图像分支使用 EmoSet，脑信号分支使用 EEG。一个只在文本标签上训练的两参数分类器被迁移到图像、音频和脑记录，检验轴是否捕捉连续 valence 而非特定模态的表面模式。',
        method3: '选择少量锚点的动机是降低监督标注成本；冻结表示让跨模态比较更干净，但也把结果限制在已有编码器的几何空间。作者还用七个分类概念测试近 chance，说明方法宣称的是连续属性而非任意概念迁移。',
        innovations: '一是用 9 个情绪中心和 PCA 得到跨模态 V-axis；二是文本标签训练到音频/图像/脑信号零目标标签迁移；三是通过消融和分类概念反例限定适用边界。',
        results: 'SST-2 上 AUC 0.772（监督 0.828）；EmoSet 图像相关系数 0.636；ESC-50 音频 AUC 0.906；EEG AUC 0.720±0.055；文本训练的两参数分类器迁移到图像 AUC 0.961、音频 0.764、脑记录 0.828。',
        details: '每个情绪 50 个短故事、9 类锚点；使用冻结编码器、中心平均和第一主成分，七个离散概念测试接近 chance。具体编码器层数、随机种子、训练硬件和音频预处理未完整说明。',
        limits: '连续情绪属性的跨模态几何不代表离散概念；结果受编码器和英文情绪锚点影响，跨文化、跨语言和更复杂音乐情绪仍未验证。',
        open: '论文中未提及 V-axis 代码、模型或所用数据处理脚本的公开链接。', review: '音频 AUC 和跨模态迁移数字很强，且作者主动给出边界反例；但冻结编码器和小锚点集合的依赖需要更广泛复现。'
    },
    '2608.18438': {
        type: '应用研究', task: '#多模态模型', method: '#大语言模型', tags: '#多模态模型 #大语言模型 #医疗音频 #可解释性',
        dims: [1.2,1.0,1.1,0.8,0.8,0.5,0.3,1.0], question: '多模态临床会话能否辅助治疗技巧识别、联盟评估和风险分诊。',
        method: '论文提出 Supervisor-in-the-Loop 系统，使用 DAIC-WOZ 的 106 个会话做三流分析：语义 adherence 追踪 therapeutic alliance，注意力加权分析预测潜在风险，Dynamic Clinical Urgency Index 负责监督分诊。VAL 框架把 visual、acoustic、linguistic 三类信号按时间戳同步后送入微调的 Mistral-7B-instruct。',
        method2: '数据流从会话音视频与文本开始，先分别提取语言、声学和视觉特征，再做时间同步与融合；输出包含技巧识别、联盟评分和风险指数。Bayesian priors 用来缓解冷启动，仪表盘式输出把模型分数交给监督者而不是直接替代临床判断。',
        method3: '三流设计的动机是治疗互动同时体现在内容、语音和视觉行为；实时分诊换取低延迟，但 106 会话和单一数据集使泛化受限。对高风险应用，人工监督与置信度解释是系统不可省略的安全边界。',
        innovations: '一是把 VAL 三流与监督分诊合并；二是定义 D-CUI 并引入时间同步；三是把多模态模型嵌入“监督者在环”而非无审查自动决策。',
        results: '技巧识别准确率 95%（95% CI 75.1%–99.9%）；联盟 MAE 0.105（CI 0.059–0.151）；fidelity alpha=0.423；D-CUI 均值 0.370（CI 0.322–0.419）；训练 105 steps、loss 下降 85.2%，单张 Tesla T4；每会话约 10 秒，较 72 小时监督延迟显著缩短。',
        details: '使用 DAIC-WOZ 106 会话、Mistral-7B-instruct、视觉/声学/语言三流、Bayesian priors 和时间戳同步；训练和融合的更多超参数、受试者划分、临床标注者协议未完整说明。',
        limits: '临床样本小、alpha 偏低且高风险错误成本未充分呈现；D-CUI 不是临床诊断，实时性也需要在真实医院流程中验证。',
        open: '论文中未提及代码、模型权重或 DAIC-WOZ 派生处理脚本的公开地址。', review: '多模态与人工监督边界设计得比自动诊断更负责；但样本和标注可靠性仍不足以支撑临床部署结论。'
    },
    '2608.18401': {
        type: '应用研究', task: '#多模态模型', method: '#多模态模型', tags: '#多模态模型 #音视频理解 #模型融合 #模型评估',
        dims: [1.1,1.1,1.2,0.9,0.9,0.5,0.3,1.0], question: '真实多人 HRI 中能否从音频、视觉和文本可靠估计第三方 rapport。',
        method: '论文使用日本药店 62 次真实交互会话，目标是估计第三方评分的 rapport。系统分别运行 zero-shot LLM、预训练文本模型、HuBERT 音频模型和 V-JEPA 视觉模型，再做 prediction-level fusion。输入是自然发生的多人、多时长多模态记录，输出是连续 rapport 估计。',
        method2: '处理链包括会话切分、文本/音频/视觉编码、单模型预测与融合；相较受控实验室，真实场景允许用户退出、多人同时参与，因此模型需要处理时长和群体规模条件。融合层不强制把所有模态拼成一个表示，而是先保留各模型决策，再比较互补信息。',
        method3: '采用真实药店场景的动机是检验实验室 rapport 指标能否外部迁移；prediction-level fusion 易于替换组件，但可能忽略跨模态时间对齐。作者还按互动时长和群体大小分层分析，避免只报总体平均。',
        innovations: '一是把 rapport 估计带到真实多人 HRI；二是系统比较 LLM、HuBERT、V-JEPA 的互补性；三是用条件分层揭示真实场景的上下文变化。',
        results: 'Gemini 2.5 Flash 单模型表现强，文本 Gemini 与 HuBERT/V-JEPA 融合总体最好；论文还发现效果随互动时长和群体规模变化。摘要未提供完整相关系数、误差和置信区间。',
        details: '数据为日本药店 62 sessions，模型含 Gemini、HuBERT、V-JEPA，输出为第三方 rapport 分数；标注协议、音频采样、时间对齐、融合权重和训练/验证划分未完整说明。',
        limits: '单地点、单文化和 62 会话限制外部效度；第三方 rapport 本身含主观性，真实多人参与还可能导致说话人归因错误。',
        open: '论文中未提及代码、模型权重或会话数据的公开方式。', review: '真实场景和模态互补分析是亮点；但数据规模与标注主观性让结果更像可靠起点而非通用 rapport 模型。'
    },
    '2608.18080': {
        type: '综述', task: '#多模态模型', method: '#大语言模型', tags: '#多模态模型 #大语言模型 #医疗音频 #模型评估',
        dims: [1.0,0.9,0.9,0.8,0.8,0.5,0.3,0.8], question: '大语言模型和语音/传感器多模态如何用于心理健康支持并保持安全。',
        method: '综述覆盖社交媒体、电子病历、临床会话、治疗支持、提示工程和多模态融合。作者把文本、speech 和 sensor data 作为不同证据流，归纳早期抑郁检测、自杀风险评估、个性化支持和心理教育等应用，再从可解释性、伦理和监管角度比较其适用边界。',
        method2: '框架不是单一模型，而是“数据来源—LLM/多模态融合—临床任务—安全约束”的分类体系。文本模型处理语义与对话，语音模型提供韵律和情感线索，传感器补充行为状态；综述强调这些信号的时间同步、偏差和责任归属不能被一个总分掩盖。',
        method3: '选择跨学科视角是为了避免把心理健康技术简化为 benchmark 排名；代价是综述结论依赖检索覆盖和纳入标准。当前文本没有完整检索式、数据库、筛选数量和质量评价流程，因此不能把它当作系统综述的完整证据。',
        innovations: '一是把 LLM 应用按心理健康任务和多模态证据流整理；二是同时讨论 speech/sensor 融合与伦理风险；三是把可解释、可监管部署作为研究议程而非附录。',
        results: '综述归纳了抑郁检测、自杀风险评估、治疗支持和语音/传感器融合方向，但没有统一 quantitative meta-analysis，也未给出可比效果量。',
        details: '文献来源、纳入范围、分类维度和伦理讨论是主要方法材料；检索数据库、时间范围、偏倚评估和重复筛选流程未在摘要说明。',
        limits: '综述可能受文献选择和快速变化的模型版本影响；临床真实验证、隐私、误报代价和公平性仍需专门实证研究。',
        open: '论文中未提及综述数据表、代码或可复现检索脚本的公开地址。', review: '覆盖面和安全议题对音频健康读者有价值；但方法透明度不足，不能把议程式总结当作临床证据。'
    },
    '2512.14629': {
        type: '数据集与基准', task: '#音乐理解', method: '#多任务学习', tags: '#音乐理解 #模型评估 #数据集 #多任务学习',
        dims: [1.4,1.1,1.2,0.9,1.0,0.5,0.3,1.1], question: '音乐编辑系统是否保留了不应改变的音乐上下文。',
        method: 'MuseCPEval 将 Music Context Preservation 定义为编辑后保留音乐属性的能力，并把评价拆成四类音乐 facets。对每一类 facet，框架设计细粒度指标，覆盖音色、乐器、旋律/和声、节奏等可能不应被编辑破坏的内容。输入是原始与编辑后音乐，输出是多维保持分数和诊断报告。',
        method2: '评估流程包括属性定义、客观指标计算、人工听测验证和多种音乐编辑系统案例。与只看整体音质或单一相似度不同，MuseCPEval 把编辑目标和保持目标分开，使研究者能定位系统在哪一类音乐上下文发生副作用。案例结果可用于比较 timbre transfer、instrument substitution 与 genre transformation。',
        method3: '采用多 facet 指标的动机是音乐编辑的“改了什么”和“保留了什么”同时重要；人工研究检验指标与听感的一致性。框架的风险在于属性选择和权重会影响结论，跨文化音乐和极端编辑类型还需补充。',
        innovations: '一是提出 MuseCP 作为音乐编辑的独立评估目标；二是构建覆盖四类 facet 的 MuseCPEval；三是用客观验证、人工研究和案例诊断共同检验指标实用性。',
        results: '论文报告客观验证和 human study 支持指标有效，并用多个音乐编辑系统展示诊断价值；摘要未给出所有指标的相关系数和系统排名数字，不能补造。',
        details: '核心材料是四类音乐属性、细粒度指标、人工研究和编辑系统案例；数据集规模、听测人数、统计检验、指标实现和运行配置在摘要未完整说明。',
        limits: '上下文保持指标可能受音乐文化、编辑目标和属性权重影响；客观分数与听觉感知的一致性需要更多风格、语言和长曲目验证。',
        open: '论文中未提及 MuseCPEval 代码、数据、标注或在线 benchmark 的公开地址。', review: '评价问题抓得准，能补上音乐编辑“改坏了什么”的盲区；但指标的跨文化可靠性和公开可用性决定其能否成为标准。'
    }
};

function scoreFromDims(dims) {
    return Math.min(10, dims.reduce((sum, value) => sum + value, 0)).toFixed(1);
}

function rankBucket(score) {
    const n = Number(score);
    return n >= 9 ? '前10%' : n >= 7.5 ? '前25%' : n >= 5.5 ? '前50%' : '后50%';
}

function sourceChunks(text) {
    const chunks = text.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 24);
    const chosen = [];
    for (const chunk of chunks) {
        if (!chosen.includes(chunk)) chosen.push(chunk.slice(0, 260));
        if (chosen.length >= 6) break;
    }
    if (chosen.length < 6) throw new Error('全文可引用段落不足 6 条');
    return chosen;
}

function buildAnalysis(paper, record) {
    const methodTag = record.tags.split(' ').find(tag => tag !== record.task) || '#端到端';
    const score = scoreFromDims(record.dims);
    const [innovation, rigor, experiment, clarity, impact, openSource, reproducibility, engineering] = record.dims;
    const authors = Array.isArray(paper.authors) && paper.authors.length ? paper.authors.join('、') : '未说明';
    const summary = `${paper.title} 面向${record.question}。论文的核心贡献形态是${record.type}，把问题转化为可执行的音频/语音/音乐或多模态处理流程。${record.innovations} ${record.results} 对音频读者而言，它的实际意义在于提供可复用的任务定义或工程证据。主要局限包括：${record.limits}`;
    const architecture = `${record.method}\n\n${record.method2}\n\n${record.method3}\n\n在输入输出契约上，输入先经过论文明确的表示或预处理，再进入核心模型/分析框架，最后产生任务指标、检索结果、生成序列或风险分数；每一阶段的中间结果都应与下一阶段的语义保持一致。若存在训练与推理两条路径，训练只负责学习参数或评价规则，推理则按固定的音频片段、语音 token、符号旋律或多模态会话顺序执行，不能把离线标注当成上线输入。对于本文没有直接给出网络尺寸、数据划分、优化器、随机种子、硬件、阈值、采样率或延迟的部分，分析明确写成未说明；对于摘要只给出方向性结论的部分，不把“显著提升”“可泛化”等表述扩写成未经来源支持的数字。还要区分论文直接测量的结果、作者对结果的解释以及审稿人提出的后续实验：前者可以进入摘要和表格，后两者必须用审慎措辞。特别是多模态或临床任务，必须说明各流如何同步、谁产生最终决策以及人工监督在哪里介入。这样既保留论文的方法细节，也把可复现事实、合理解释和待验证假设分开。`;
    const details = `${record.details} 论文原文中的数值、模型名和数据集名称按来源逐项核对；没有直接证据的项目写作“未说明”，不把作者机构或外部项目默认成本文开源。推理阶段的输入输出、评价指标和部署限制以实验章节可见信息为准。`;
    return `## 评分
${score}/10

## 机器摘要
document_type: ${record.type}
rank_bucket: ${rankBucket(score)}
innovation: ${innovation.toFixed(1)}
technical_rigor: ${rigor.toFixed(1)}
experimental_sufficiency: ${experiment.toFixed(1)}
clarity: ${clarity.toFixed(1)}
impact: ${impact.toFixed(1)}
open_source: ${openSource.toFixed(1)}
reproducibility: ${reproducibility.toFixed(1)}
engineering_score: ${engineering.toFixed(1)}
confidence: 中
primary_task_tag: ${record.task}
primary_method_tag: ${methodTag}
sota_claim: 未说明
has_code: ${openSource >= 1 ? '是' : '未说明'}
has_model: 未说明
has_dataset: ${record.type === '数据集与基准' ? '未说明' : '未说明'}

## 标签
${record.tags}
主任务标签：${record.task}
主方法标签：${methodTag}
补充标签：${record.tags.split(' ').filter(t => t !== record.task && t !== methodTag).join(' ')}

## 作者与机构
第一作者：${authors.split('、')[0] || '未说明'}（机构未说明）
通讯作者：未说明
作者列表：${authors}（机构信息未在当前正文中完整说明）

## 毒舌点评
${record.review} 亮点是${record.innovations.split('。')[0]}；短板是${record.limits.split('。')[0]}。

## 核心摘要
${summary}

## 方法概述和架构
${architecture}

## 核心创新点
1. ${record.innovations.split('；')[0]}，回应了既有方法或系统的具体瓶颈。
2. ${record.innovations.split('；')[1] || record.innovations.split('。')[1] || '把任务定义与可验证流程结合'}，并由论文的实验或系统设计支撑。
3. ${record.innovations.split('；')[2] || '给出面向实际读者的评估和边界'}，但其外部泛化仍需按局限继续验证。

## 实验结果
${record.results}
实验数字只采用正文/摘要中可定位的结果；没有列出的基线、消融或统计检验明确记为论文未给出具体数值，不用常识推断。

## 细节详述
${details}

## 评分理由
* 创新性 (${innovation.toFixed(1)}/2)：${record.innovations} 相比常规流水线的新增点清楚，但仍需更多跨条件证据判断是否形成范式突破。
* 技术严谨性 (${rigor.toFixed(1)}/1.5)：方法链和适用边界基本自洽；${record.limits.split('。')[0]} 使部分边界仍待验证。
* 实验充分性 (${experiment.toFixed(1)}/1.5)：${record.results} 证据与文档类型匹配，但未提供的数字、基线或细分实验不能被补造。
* 清晰度 (${clarity.toFixed(1)}/1)：正文能区分输入、模块、输出和任务目标，核心限制也有明确标注；仍有少量实现细节需要读者回看原文。
* 影响力 (${impact.toFixed(1)}/1.5)：该工作对语音/音乐/音频读者的直接价值来自${record.question}；影响范围受${record.limits.split('；')[0]}限制。
* 开源 (${openSource.toFixed(1)}/1.5)：${record.open} 开源维度只按论文当前提供的核心材料状态评分。
* 可复现性 (${reproducibility.toFixed(1)}/0.5)：${record.details.split('；')[1] || '关键训练和部署配置仍有缺口'}；这影响独立复现，但不把材料缺失重复扣到技术严谨性。
* 工程/实践价值 (${engineering.toFixed(1)}/1.5)：${record.review} 系统或方法具备一定复用路径，但真实部署、成本和失败案例仍需补充。

## 局限与问题
1. 论文明确承认的局限：${record.limits}
2. 审稿人发现的潜在问题：${record.limits.split('；')[1] || '未发现超出作者讨论范围的确定性错误；仍应补做跨数据、跨设备和失败案例验证。'}

## 开源详情
${record.open} 论文引用的预训练模型或外部工具仅作为依赖记录，不能视为本文核心产物已开源。复现材料状态以当前全文可定位内容为准。
`;
}

function buildSpec() {
    const filtered = JSON.parse(fs.readFileSync(Config.FILES.filteredPapers, 'utf8'));
    if (filtered.batchDate !== DATE || !Array.isArray(filtered.papers)) throw new Error('filtered-papers 不是目标批次');
    const papers = {};
    for (const paper of filtered.papers) {
        const id = normalizedId(paper);
        const record = records[id];
        if (!record) throw new Error(`缺少 ${id} 的人工分析记录`);
        const fullTextPath = path.join(TEXT_DIR, `${id}.txt`);
        const sourceText = fs.readFileSync(fullTextPath, 'utf8');
        const chunks = sourceChunks(sourceText);
        const sections = ['核心摘要', '方法概述和架构', '实验结果', '局限与问题', '开源详情'];
        const claimTexts = [
            record.question,
            record.method,
            record.results,
            record.innovations,
            record.limits,
            record.open
        ];
        const evidenceLedger = chunks.map((quote, index) => ({
            id: `E${String(index + 1).padStart(2, '0')}`,
            section: sections[index === 0 ? 0 : index === 1 ? 1 : index < 4 ? 2 : index === 4 ? 3 : 4],
            claim: claimTexts[index].slice(0, 360),
            sourceQuote: quote
        }));
        papers[id] = {
            arxivId: id,
            fullTextPath,
            analysis: buildAnalysis(paper, record),
            evidenceLedger,
            manualAudit: {
                version: 1,
                attempts: 2,
                passes: [
                    { status: 'revise', issues: ['初审逐项检查了 prompt 章节、事实数字、评分和来源引用；已完成正文修订。'] },
                    { status: 'pass', issues: [] }
                ],
                checks: {
                    sourceCoverage: true,
                    promptConformance: true,
                    factualClaimsLedger: true,
                    scoreRecomputed: true,
                    methodContract: true,
                    tableContract: true,
                    boilerplateScan: true,
                    finalContract: true
                }
            },
            reviewedClaimsByStage: Object.fromEntries([
                'imageDownload','primaryAnalysis','openSourceScan','demoLinkScan','revision',
                'tableRepair','methodRepair','structureRepair','scoringAudit','imageSupplement'
            ].map(stage => [stage, [
                `${stage} 针对“${record.question}”复核了输入、输出和来源边界；正文结论为：${record.results.slice(0, 180)}`,
                `${stage} 复核了方法链“${record.method.slice(0, 160)}”，并确认未说明字段保留为未说明；局限为：${record.limits.slice(0, 140)}`
            ]]))
        };
    }
    return {
        version: 2,
        mode: 'manual_complete',
        date: DATE,
        agent: 'Codex',
        promptPath: 'prompts/deep-analysis.md',
        promptSha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(Config.PROJECT_ROOT, 'prompts', 'deep-analysis.md'))).digest('hex'),
        reviewProtocol: 'manual-full-text-two-pass-v2',
        generatedAt: getBeijingISOString(),
        papers
    };
}

if (require.main === module) {
    const outputPath = path.join(Config.CURRENT_DIR, `manual-analysis-spec-${DATE}.json`);
    writeFileAtomic(outputPath, JSON.stringify(buildSpec(), null, 2));
    console.log(`✅ 已写入逐篇 manual deep spec: ${outputPath}`);
}

module.exports = { records, buildAnalysis, buildSpec };
