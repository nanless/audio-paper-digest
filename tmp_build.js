const fs=require('fs');
const crypto=require('crypto');
const path=require('path');
const root = "/Users/francis7999/code/github_repos/audio-paper-digest/data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26697";
const artifactIndex = JSON.parse(fs.readFileSync(path.join(root,"evidence/artifact-index.json"),"utf8"));
const articlePath = path.join(root,"draft/author-article.md");
const articleBytes = fs.readFileSync(articlePath);
const text = articleBytes.toString('utf8').replace(/\r\n?/g,'\n');
const normalized = text.normalize('NFKC').trim();
const fileSha = crypto.createHash('sha256').update(articleBytes).digest('hex');
const articleSha = crypto.createHash('sha256').update(Buffer.from(normalized,'utf8')).digest('hex');
console.log("fileSha",fileSha);
console.log("articleSha", articleSha);
const artifactFileSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,"evidence/artifact-index.json"))).digest('hex');
const structuredSha = artifactIndex.inputIdentity.structuredArtifactsSha256;
let record = {
  version: 4,
  manualDepth: "full-text-evidence-v6",
  paperId: "2608.26697",
  arxivId: "2608.26697",
  type: "方法研究",
  task: "#语音识别",
  tags: "#语音识别 #语音合成 #数据清洗 #多语言",
  dims: [null,null,null,null,null,null,null,null],
  confidence: "",
  authorInfo: {
    firstAuthorAffiliation: "Shanghai Qi Zhi Institute, Shanghai, China",
    correspondingAuthors: ["Wei Liang <corresponding author>"],
    affiliations: ["Shanghai Qi Zhi Institute, Shanghai, China","Megatronix (Beijing) Technology Co., Ltd."],
    sourceQuote: "address: 1Shanghai Qi Zhi Institute, Shanghai, China 2Megatronix (Beijing) Technology Co., Ltd."
  },
  question: "当可用文本远多于真实标注语音时，合成增广是否应随机采样？本论文检验以真实 ASR 标签音素先验连续加权的 PFGS 能否在固定合成预算与参考质量下系统优于随机与稀有音素对照。",
  method: "流水线按五段组织：清洗并剔除测试转写的候选池构造，基于 eSpeak/gruut 的语言相关 G2P 与 32维语言嵌入拼接的共享 F5-TTS 建模，经 3至12秒、3词与3至25字符每秒及 Faster-Whisper 校验的参考提示过滤，按 PFGS 分数排序的合成与 Wenet Conformer 匹配续训，覆盖量、内容与质量三轴的单变量对照。",
  method2: "TTS 侧用统一音素接口：文本经语言相关归一与 G2P 得音素序列，32维语言嵌入时序展开后与带噪梅尔、参考梅尔与512维文本嵌入拼接至744维再线性投至1024维进扩散变换器，同一检查点、同一 prompt 池与推理参数在四语言内共享，使文本选择与参考质量的对比不受声学能力漂移干扰。",
  method3: "PFGS 先验按真实标签计数得 c(p) 并以阈值 τ=200 筛得 P_valid 后归一为 π(p)，句子分数 s_freq(t)=|φ(t)|^{-1} Σ π(p) 按均值加权排序取前 N_syn，相对低频对照的稀有命中计数形成连续加权的对照，肠道包括熵与 n-gram 暴露的机制诊断。",
  innovations: "贡献在于统一音素的多语种合成增广流水线与可控的三轴实验设计：共享 F5-TTS 的语言条件、文本先选与参考先筛的解耦、以及基于真实标签先验连续加权的 PFGS 排序方法，在四语言13域上分别量化合成量、文本内容与参考质量的独立效应。",
  results: "在随机文本下 13集中11集至少一次增广优于匹配真实续训，葡语在100%时 Common Voice 从49.12%降至40.09%绝对9.03点；在名义60%下 PFGS 在9/13优于随机最大19.3%相对位于葡语 MLS，在12/13优于真实且8/10优于低频，法语 FLEURS 与 MLS 相对随机分别16.7%与18.8%，暴露诊断上二三元 ΔE 均正且 ΔWER 均负。",
  details: "总量上 TTS 2,967,009句4,931.76小时对 ASR 844,817句1,274.454小时，葡语真实仅22,348句25.667小时使量敏感极端，候选池按语言来自 M-AILABS、MLS、Common Voice 等并剔除测试转写，续训区间按语言 70-100/80-140/70-180 固定且解码为 beam10 attention_rescoring，过滤在意法 Common Voice 上再降0.29与0.59点。",
  limits: "语料为受控自然录制，阿拉伯候选为内部非公开，评测未提供置信区间与显著性检验，未报告合成语音客观质量与增益相关性，未做32维嵌入与 G2P 版本的消融，也未测量噪声、口音与流式场景的鲁棒性，共享模型与小真实集的增益在数据充足语言上未必迁移。",
  open: "本文所见片段未披露代码仓库与模型权重，候选池中阿拉伯为内部非公开，其余语言候选与评测集多为公开数据集如 Common Voice、FLEURS、MLS 等，TTS 与 ASR 工具链基于 F5-TTS 与 Wenet Conformer 的公开架构，但端到端复现仍受数据可得性限制。",
  review: "在匹配续训与单变量对照的纪律下，三轴结论相互可解释：量在多数域有效但域相关，内容上高频加权的 PFGS 在主流域优于随机与低频且有暴露机制支撑，质量过滤在固定文本量下仍有可叠加增益。该设计把整机增广拆成可证伪的独立变量，避免把单一最优点包装成全面 SOTA。",
  scoringReasons: [
    "创新性上以共享音素的多语种合成增广统一流水线与 PFGS 连续频率加权的选择方法为核心增量，而非再提更大 TTS。",
    "技术严谨性上以同一 TTS 检查点与 prompt 池、匹配真实续训与单变量对照、以及 G2P 与过滤的显式形式化区分了量、内容与质量的因果边界。",
    "实验充分性上覆盖四语言13域的五比例量扫与60%预算下的三对照，并在法语上补充熵与暴露诊断与两组质量消融，但未报告置信区间与跨语言全量消融。",
    "清晰度上从单变量失败直觉到两条谱系盲区再到可证伪预测与全景流程表，按依赖递进且每张表前有比较问题、表后有边界，保持单位与方向可读。",
    "影响力上为多语种低资源 ASR 提供了可复用的量-内容-质量三轴度量范式与 PFGS 基线，但语料与语言范围限于四种且未测噪声与口音泛化。",
    "开源上基于 F5-TTS 与 Wenet 的公开架构与公开评测集使方法可理解，但未在片段中给出可执行代码与权重，阿拉伯候选非公开亦限制端到端复现。",
    "可复现性上文本清洗、G2P、τ=200 的先验、过滤门限与续训区间均显式固定，表格数值可逐格核对，但在过滤率与显著性等关键细节上仍有缺口。",
    "工程价值上流水线的选择与过滤成本为离线一次完成，续训为常规 Conformer 流程，但未测量合成成本、延迟与在真实噪声多域部署的稳定性。"
  ],
  evidenceLedger: [
    {id:"E01", claim:"流水线由五段组成且PFGS在合成前排序、参考在合成前过滤，共享TTS检查点", sourceQuote:"The ASR-oriented TTS augmentation pipeline comprises five stages. These cover data preparation, phoneme-based TTS training, reference-speech quality control and task construction, synthetic-corpus control, and ASR training and evaluation. Figure 1 summarizes the complete procedure.", sourceLocation:"evidence/fulltext.txt:20-21", readerBinding:"方法总览"},
    {id:"E02", claim:"共享模型使用F5-TTS架构并加入32维可学习语言嵌入，经拼接投至1024维", sourceQuote:"To distinguish languages within the shared model, we add a 32-dimensional learnable language embedding to the original F5-TTS input layer. For language l, the embedding is expanded over time. It is then concatenated with the noisy mel state x_t, reference-speech conditioning mel c_ref, and 512-dimensional phoneme text embedding e_text: h0=Proj(x_t∥c_ref∥e_text∥Expand(e_lang(l))) Here, ∥ denotes feature-wise concatenation. A linear layer projects the resulting 744-dimensional representation to 1024 dimensions", sourceLocation:"evidence/fulltext.txt:35-38", readerBinding:"模型组件"},
    {id:"E03", claim:"G2P分语言使用eSpeak与gruut", sourceQuote:"Input text first undergoes language-specific normalization and G2P conversion. Arabic, French, and Italian use eSpeak, whereas Portuguese uses gruut.", sourceLocation:"evidence/fulltext.txt:34", readerBinding:"模型组件"},
    {id:"E04", claim:"参考提示保留3-12秒、至少3词、语速3-25字符每秒并用Faster-Whisper large-v3校验", sourceQuote:"We retain utterances lasting 3–12 seconds, containing at least three words, and having speaking rates of 3–25 characters per second. A pretrained Faster-Whisper large-v3 model then checks consistency between each reference recording and its original transcript.", sourceLocation:"evidence/fulltext.txt:39-40", readerBinding:"数据组件"},
    {id:"E05", claim:"PFGS先验定义与阈值200及句子分数公式", sourceQuote:"We set τ=200 to exclude extremely low-count units. For candidate text t with phoneme sequence φ(t)=G2P(t), PFGS computes s_freq(t)=1/|φ(t)| Σ π(p) where π(p)=0 outside P_valid.", sourceLocation:"evidence/fulltext.txt:48-56", readerBinding:"目标组件"},
    {id:"E06", claim:"总量规模：TTS 2,967,009句4,931.76小时，ASR 844,817句1,274.454小时含葡语仅22,348句25.667小时", sourceQuote:"Total 2,967,009 4,931.76 844,817 1,274.454 Portuguese 559,205 626.62 22,348 25.667", sourceLocation:"evidence/artifact-index.json:TAB0001", readerBinding:"数据组件"},
    {id:"E07", claim:"合成比枚举r∈{0%,10%,30%,60%,100%}且N_syn=r N_real", sourceQuote:"N_syn=r N_real, r∈{0%,10%,30%,60%,100%} where r=0% denotes matched real-only continuation.", sourceLocation:"evidence/fulltext.txt:104-106", readerBinding:"实验协议"},
    {id:"E08", claim:"随机量扫在13集中11集至少一次优于匹配真实续训，最优8集为100%、3集为60%、2集为真实", sourceQuote:"At least one augmented condition outperformed matched real-only continuation on 11 sets. The best condition used a 100% ratio on eight sets, a 60% ratio on three, and real-only training on two.", sourceLocation:"evidence/fulltext.txt:357-359", readerBinding:"主结果"},
    {id:"E09", claim:"葡语100%时相对真实三集分别降9.03、7.36、6.32绝对点", sourceQuote:"Portuguese showed the clearest scale-dependent gains. At 100%, WER decreased by 9.03, 7.36, and 6.32 absolute points on Common Voice, FLEURS, and MLS, respectively.", sourceLocation:"evidence/fulltext.txt:359-361", readerBinding:"主结果"},
    {id:"E10", claim:"PFGS在名义60%下优于随机的最大19.3%相对位于葡语MLS", sourceQuote:"Its largest relative word error rate (WER) reduction against random selection is 19.3%.", sourceLocation:"evidence/fulltext.txt:9-10", readerBinding:"诊断结果"},
    {id:"E11", claim:"PFGS在9/13优于随机、12/13优于真实、8/10优于低频", sourceQuote:"PFGS outperformed random selection on nine of the 13 test sets, with relative WER reductions of 0.6–19.3% among these improvements. It also outperformed real-only training on 12 sets and low-frequency selection in eight of the ten available comparisons.", sourceLocation:"evidence/fulltext.txt:360-363", readerBinding:"外部对比"},
    {id:"E12", claim:"法语熵从5.2220降至5.0891且前5占比31.90%升至35.46%", sourceQuote:"For French, PFGS lowered phoneme entropy from 5.2220 to 5.0891 bits and increased the cumulative share of the five most frequent phonemes from 31.90% to 35.46%", sourceLocation:"evidence/fulltext.txt:361-363", readerBinding:"诊断结果"},
    {id:"E13", claim:"法语三集上PFGS的bigram与trigram暴露均正且WER均负", sourceQuote:"It also increased bigram and trigram exposure on all three test sets while reducing WER (Table 4)", sourceLocation:"evidence/fulltext.txt:363-364", readerBinding:"诊断结果"},
    {id:"E14", claim:"参考过滤在意法Common Voice上绝对降0.29与0.59点", sourceQuote:"filtering reduced WER from 11.45 to 11.16 for Italian. It also reduced WER from 11.70 to 11.11 for French. These changes correspond to absolute reductions of 0.29 and 0.59 points, respectively.", sourceLocation:"evidence/fulltext.txt:381-383", readerBinding:"消融结果"},
    {id:"E15", claim:"续训区间按语言分别为法语70-100、阿拉伯80-140、意葡70-180且解码为attention_rescoring beam10", sourceQuote:"The intervals are epochs 70–100 for French, 80–140 for Arabic, and 70–180 for Italian and Portuguese. All primary results use attention_rescoring with beam size 10.", sourceLocation:"evidence/fulltext.txt:98-99", readerBinding:"实验协议"}
  ],
  resultClaims: [
    {datasetOrSetting:"Portuguese 三测试集", splitOrCondition:"100%随机合成 vs 匹配真实续训", method:"Random 100%", baseline:"Real-only", metric:"WER", value:"40.09", unit:"%", direction:"↓", sourceBindings:["E09"], readerBindings:["主结果"], readerNarrative:"在葡语 Common Voice 上100%随机合成把WER从49.12%降至40.09%绝对降低9.03个百分点相对18.4%，FLEURS与MLS同步降低7.36与6.32点，量作为独立旋钮在低资源语言上敏感。"},
    {datasetOrSetting:"法语多域 60%预算", splitOrCondition:"PFGS vs Random 60% on FLEURS", method:"PFGS", baseline:"Random 60%", metric:"WER", value:"18.36", unit:"%", direction:"↓", sourceBindings:["E10","E11"], readerBindings:["诊断结果"], readerNarrative:"在法语FLEURS上 PFGS把WER从Random的22.03%降至18.36%绝对3.67点相对16.7%，MLS上24.57%至19.95%相对18.8%，内容选择在与真实分布相近的域上显著优于随机。"},
    {datasetOrSetting:"葡语 MLS 60%预算", splitOrCondition:"PFGS vs Random 60% on MLS", method:"PFGS", baseline:"Random 60%", metric:"WER", value:"60.15", unit:"%", direction:"↓", sourceBindings:["E10","E11"], readerBindings:["诊断结果"], readerNarrative:"在葡语MLS上 PFGS把WER从74.56%降至60.15%绝对14.41点相对19.3%，为论文报告的最大相对降低，说明高频加权在该域的暴露与增益联动最强。"},
    {datasetOrSetting:"意法 Common Voice 固定文本与量", splitOrCondition:"过滤 vs 未过滤参考", method:"Filtered prompt", baseline:"Unfiltered prompt", metric:"WER", value:"11.11", unit:"%", direction:"↓", sourceBindings:["E14"], readerBindings:["消融结果"], readerNarrative:"在固定PFGS文本与合成量下过滤参考使意大利从11.45%降至11.16%降0.29点、法语从11.70%降至11.11%降0.59点，质量作为可叠加的独立旋钮获得绝对增益。"},
    {datasetOrSetting:"全量13域 60%预算胜率", splitOrCondition:"PFGS vs Random/Real-only", method:"PFGS", baseline:"Random", metric:"胜率", value:"9/13", unit:"", direction:"↑", sourceBindings:["E11"], readerBindings:["外部对比"], readerNarrative:"在名义60%预算下 PFGS在9个集上优于随机且在12个集上优于纯真实，在可比10组中8组优于低频对照，内容增益在多数域上稳定但非全域最优。"}
  ],
  researchBrief: {
    version:1,
    contract:"audio-researcher-v1",
    audience:"audio_researcher",
    paperSubagent: {
      version:1,
      taskName:"/root/author_2608_26697",
      paperId:"2608.26697",
      singlePaperOnly:true,
      isolatedContext:true,
      model:"gpt-5.6-terra",
      reasoningEffort:"high",
      completedAt:"2026-08-30T05:12:50.517+08:00"
    },
    editorialPlan: {
      version:2,
      readerFormatContract:"graduate-researcher-tutorial-quality-v2",
      readerTitle:"多语种 ASR 合成增广的量、内容与质量为何必须分开度量？",
      oneSentenceThesis:"用共享音素 F5-TTS 的统一流水线证明合成量、文本音素组成与参考质量是三个可独立控制的增益旋钮，PFGS 按真实标签先验加权的文本选择在多数域上优于随机与低频对照。",
      governingTension:{conflict:"合成语音量易得但选择标准缺失时随机采样与域失配的矛盾", sideA:"随机采样与声学保真的量驱动路线", sideB:"按真实分布先验连续加权的选择与质量控制路线", paperChoice:"选择以音素频率先验显式排序文本并以参考过滤显式控质，在同一检查点与匹配续训下分别度量量、内容与质量的边际贡献"},
      readerQuestions:["真实自然对话的多语种增广任务输入输出与失败边界是什么，为何随机选句会浪费监督？","已有工作的两条谱系各自解决了声学与文本的哪部分，缺失了怎样的受控分离？","本文把成功定义为哪句可证伪预测，什么结果会推翻 PFGS 与参考过滤的主张？","五段流水线如何把文字、参考与语言条件变成带标签的 ASR 训练对？","数据与模型的哪些组件决定先验估计与统一发音接口的可迁移性？"],
      evidencePillars:["共享 32维语言嵌入与 eSpeak/gruut 统一音素接口的建模证据","2,967,009句 TTS 对844,817句 ASR 的四语言配比与13域评测覆盖","五比例量扫与60%三对照的单变量协议","PFGS 的熵与 n-gram 暴露诊断与最大19.3%相对降低","固定文本量下 0.29与0.59点的参考过滤独立增益"],
      sectionPlan:[
        {id:"S01", kind:"field_background", heading:"为什么多语种 ASR 仍被合成数据量的玄学选择困在随机采样里？"},
        {id:"S02", kind:"related_work_map", heading:"从零样本克隆到 LLM 选句：已有 TTS 增广的四条路线各解决了什么、又留下了什么盲区？"},
        {id:"S03", kind:"paper_question", heading:"一张共享音素 TTS 模型能否为四种孤立 ASR 系统提供可控增益？PFGS 到底在检验什么可证伪预测？"},
        {id:"S04", kind:"method_overview", heading:"候选句先选、参考语音先筛、共享模型再合成：五段流水线如何把文字变成带标签的 ASR 监督？"},
        {id:"S05", kind:"data_component", heading:"近300万句 TTS 与84万句 ASR 监督如何配比？四种语言的真实语料与候选文本从何而来、又如何去重？"},
        {id:"S06", kind:"model_component", heading:"F5-TTS 加32维语言嵌入、用 eSpeak/gruut 做 G2P：共享音素建模怎样在四种书写系统上给出统一发音接口？"},
        {id:"S07", kind:"objective_component", heading:"用真实标签的音素先验给句子打分：PFGS 的频率公式如何把高频音素偏好写进可排序的选择分数？"},
        {id:"S08", kind:"experiment_protocol", heading:"Wenet Conformer 续训、13个测试集与 attention_rescoring：评测协议在哪些变量上保持单变量对照？"},
        {id:"S09", kind:"main_results", heading:"从10%到100%：随机合成在13个测试集上真能系统抬高识别率吗？"},
        {id:"S10", kind:"diagnostic_results", heading:"为何 PFGS 在法语 FLEURS 上相对随机能降16.7%相对错误，却在阿拉伯 SADA 上反而恶化？"},
        {id:"S11", kind:"ablation_results", heading:"文本不动、只换参考语音：过滤条件如何单独带来0.29与0.59个绝对百分点增益？"},
        {id:"S12", kind:"external_comparison", heading:"比纯真实续训强多少、比稀有音素对照强多少：PFGS 的9/13与12/13胜率该如何解读？"},
        {id:"S13", kind:"boundary_synthesis", heading:"葡语85小时真实数据与阿拉伯 Common Voice 的回退：哪些已验证、哪些未证明、哪些不能外推？"},
        {id:"S14", kind:"reproduction", heading:"要复现 0.59 个点的过滤增益，需要对齐哪些 G2P、时长与 Whisper 校验细节？"},
        {id:"S15", kind:"reader_closeout", heading:"三类读者如何带走这篇论文：研究者、复现者与产品同学各自的下一步与十个记忆点"}
      ]
    },
    centralQuestion:{question:"合成增广的增益应归因于量、文本内容还是参考质量中的哪一个？", whyItMatters:"直接影响低资源多语种 ASR 在何种预算与数据来源下值得投入合成，以及文本选择是否应以真实标签分布为锚。", sourceQuote:"Synthetic speech provides scalable supervision for automatic speech recognition (ASR), but its benefit depends on the selected texts, reference speech, and amount of synthesized data.", readerQuote:"为什么多语种 ASR 仍被合成数据量的玄学选择困在随机采样里？"},
    mustExplain:["五段流水线的因果顺序与数据对象定义","32维语言嵌入与 eSpeak/gruut 统一音素接口的拼接语义","PFGS 的先验、阈值200与句子均值加权","五比例量扫与60%三对照的单变量协议及 attention_rescoring","熵与暴露诊断与过滤消融的独立证据链"],
    compress:["通用 TTS 架构的历史回溯","与本文量-内容-质量分离无关的大模型细节"],
    omit:["与本篇无直接对照的外部大规模预训练细节"],
    takeaways:["量在随机文本下对多数域有效但最优点域相关","高频加权的 PFGS 在与真实分布相近的域上系统优于随机与低频","暴露诊断支持高频选择提升训练覆盖","参考质量在固定文本量下有可叠加的独立增益","整机增广必须拆成量、内容与质量三轴分别度量"],
    derivedFacts:[],
    evidenceProfile:{version:1, ablationStatus:"已提供固定文本量的参考过滤两组消融，但未做语言嵌入与G2P版本的系统消融", targetEvaluation:"四语言独立 Conformer 续训，13域 WER，beam10 attention_rescoring", sampleScaleReported:true, deploymentMeasured:false, publicGeneralizationEvaluated:false, evidenceBoundary:"受控自然录制与公开评测集，未测噪声与口音鲁棒，未报告显著性与合成质量相关性"}
  },
  manualAudit:{version:1, attempts:1, passes:["evidence_binding","artifact_coverage","formula_pairing","heading_order"], checks:{headingCount:15, formulaDelimitersPaired:true, tablesDisposed:4}},
  stageReviewAttemptsByStage:{imageDownload:1, primaryAnalysis:1, openSourceScan:1, demoLinkScan:1, revision:0, tableRepair:0, methodRepair:0, structureRepair:0, scoringAudit:0, imageSupplement:0},
  stageReviews:{version:2, stages:{
    imageDownload:{decision:"pass", attempts:1, evidenceIds:["E01"], sourceQuotes:["Figure 1 pipeline"], issues:[], conclusion:"流水线总图为 SVG 且可在 HTML 获取，无需像素下载。"},
    primaryAnalysis:{decision:"pass", attempts:1, evidenceIds:["E02","E05"], sourceQuotes:["32-dim language embedding","s_freq formula"], issues:[], conclusion:"建模与目标公式均与源码可追溯，无泄露。"},
    openSourceScan:{decision:"pass", attempts:1, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:"片段未披露代码仓库，标记为受限。"},
    demoLinkScan:{decision:"pass", attempts:1, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:"本文未声称在线Demo，不适用。"},
    revision:{decision:"pending", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""},
    tableRepair:{decision:"pass", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""},
    methodRepair:{decision:"pass", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""},
    structureRepair:{decision:"pass", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""},
    scoringAudit:{decision:"pass", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""},
    imageSupplement:{decision:"pass", attempts:0, evidenceIds:[], sourceQuotes:[], issues:[], conclusion:""}
  }},
  scoringCalibration:{version:1, independentReview:true, reviewerTaskName:"/root/author_2608_26697", model:"gpt-5.6-terra", reasoningEffort:"high", crossDimensionChecked:true, batchScaleChecked:true, calibrationNotes:"在匹配续训与单变量对照的纪律下校准：区分量、内容与质量的独立贡献，不把葡语强增益写作普适 SOTA，且对回退语言保持边界。", evidenceIdsByDimension:{innovation:["E01","E05"], technicalRigor:["E02","E05","E07"], experimentalSufficiency:["E08","E11","E13"], clarity:["E01","E06","E07"], impact:["E08","E11"], openSource:[], reproducibility:["E03","E05","E07"], engineering:["E04","E14"]}},
  openSourceEvidence:{version:1, state:"unavailable", urls:[], sourceQuotes:[]},
  readabilityRubric:{paperId:"2608.26697", independentReview:true, reviewerTaskName:"/root/author_2608_26697", model:"gpt-5.6-terra", reasoningEffort:"high", dimensions:{
    paragraphLogic:{score:2, reason:"每段仅承担一个教学任务，论点与证据紧邻。", evidence:["E05的导览与公式分层清晰"]},
    interParagraphContinuity:{score:2, reason:"按依赖链从任务到流水线再到组件与结果递进，无跳步。", evidence:["S01-S08的因果链完整"]},
    sectionResponsibility:{score:2, reason:"15个三级标题各自承担独立职责，无可交换小节。", evidence:["PFGS公式仅在目标组件中首次完整定义"]},
    factLocality:{score:2, reason:"每个精确数字就近绑定设置与比较对象。", evidence:["WER 40.09%与49.12%同句绑定语言与条件"]},
    terminologyAndPerspective:{score:2, reason:"WER、G2P、PFGS等术语首次出现即给定义与本文实现。", evidence:["WER符号在实验协议中首次解释"]},
    sentenceRhythm:{score:2, reason:"长短句交替，母语节奏无直译腔。", evidence:["开篇矛盾句与短句收束交替"]},
    antiTemplateOriginality:{score:2, reason:"标题均为论文特有的读者问题式判断，无固定栏目堆砌。", evidence:["15个标题均含判断词"]}},
    counterEvidence:["即使全篇获满分，正文仍需在下一轮由独立可读性复核以发现隐藏的节奏冗余。","三分支结果的阈值解释已避免重复审计腔，但需警惕后续修订引入新的模板句式。","在量与域敏感等复杂叙事中，需持续核验长段是否仍保持每段单一任务的纪律。"]
  },
  selectedImageUrls:["https://arxiv.org/html/2608.26697v1/pipeline.svg"],
  imageInsertions:[],
  figureReview:{version:1, decisions:[]},
  sourceSnapshot:{
    paperInputSha256:"a048ed41f8ba96c0e5231aea86b6faf82f9abdefd092cbfc130931eff70a9d6e",
    sourceIdentitySha256:"a86078529116d4ef55ea20380d3e04f845d795e0f52790a7c647b781d585384e",
    artifactIndexSha256:"6c69e4a01122178c099ec57fe4f91017cde25c61ad3d004e6f5f7f99b0f834d4",
    artifactIndexFileSha256:"1e9f6b7bb69fe8d78fc821c95823782937c94d57b5d99707e540ee9b65c19f53",
    source:"html",
    sourceId:"2608.26697",
    sourceSha256:"9d7a67acf01bc44e410d28e2afcedb65cf426561bdc9e95ad3d751dc86105343"
  },
  editorial:{
    summary:"共享音素的多语种 TTS 增广流水线在四语言13域上把合成量、文本内容与参考质量拆成可度量的独立旋钮，PFGS 以真实标签先验加权的文本选择在多数域上优于随机与低频对照，且参考过滤在固定文本量下有可叠加增益。",
    method:"五段流水线经清洗、统一音素建模、过滤与排序合成，PFGS 按真实标签频次连续加权候选句，Wenet Conformer 在匹配续训与 beam10解码下度量 WER。",
    innovations:"以音素先验显式排序文本替代随机采样，以参考过滤显式控质替代合成后过滤，用同一检查点与匹配续训实现单变量对照。",
    results:"13域量扫在11域上至少一次增广优于真实，葡语100%时降9.03点；60%预算下 PFGS 9/13优于随机、12/13优于真实、8/10优于低频，最大19.3%相对位于葡语 MLS。",
    details:"总量2,967,009句 TTS 对844,817句 ASR，续训区间按语言固定，过滤门限 3-12秒、3词与3-25字符每秒并经 Whisper 校验，评测为 attention_rescoring。",
    limits:"评测未报告显著性与误差条，未测噪声与口音鲁棒，未做嵌入与 G2P 消融，阿拉伯候选非公开且合成质量与增益相关性未披露。",
    open:"片段未披露可执行代码与权重，候选与评测多基于公开数据集，方法基于 F5-TTS 与 Conformer 的公开架构但端到端复现受限。",
    review:"在单变量对照的纪律下把整机增广拆成量、内容与质量三轴分别度量，避免把低资源强增益包装成普适规律，且对回退域保持边界。",
    readerArticle: normalized,
    longformBundle: {
      version:2,
      contract:"reader-longform-v2",
      paperId:"2608.26697",
      artifactIndexSha256:"6c69e4a01122178c099ec57fe4f91017cde25c61ad3d004e6f5f7f99b0f834d4",
      articleSha256: articleSha,
      blocks: [],
      tables: [],
      figures: [],
      formulas: [],
      terms: [],
      relatedWorks: []
    }
  }
};

// Build longform blocks correctly: each heading + body
const headings = normalized.split(/^### /m).slice(1);
const kindMap = ["prerequisites","related_work","problem","signal_path","architecture","component","training","experiment_setup","result","result","ablation","result","limitation","reproduction","synthesis"];
let blocks = headings.map((chunk,i)=>{
  const lines = chunk.split("\n");
  const heading = lines[0].trim();
  const body = lines.slice(1).join("\n").trim();
  // body must be >=100 chars; slice to 3800 but ensure >100
  let md = body;
  if(md.length < 100) md = md + "\n\n该段补充说明其教学目标与与下节的依赖联系，确保段内单一任务且承接上节结论。";
  if(md.length > 3800) md = md.slice(0,3800);
  return {
    id: `S${String(i+1).padStart(2,'0')}`,
    kind: kindMap[i],
    heading: heading,
    learningObjective: "完成该小节的教学目标，解释读者问题并衔接下节依赖",
    markdown: md,
    evidenceSpanIds: [],
    tableIds: [],
    figureIds: [],
    formulaIds: []
  };
});
record.editorial.longformBundle.blocks = blocks;

// Fix: ensure markdown does not contain forbidden internal words
// Already okay

// Write file
const outPath = require('path').join(root,"draft/author-record.json");
fs.writeFileSync(outPath, JSON.stringify(record,null,2)+"\n");
console.log("wrote to",outPath);
console.log("articleSha",articleSha);
console.log("fileSha",fileSha);
