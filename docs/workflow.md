# 主流程详解

## 主流程详解

默认日更入口是 `./run-daily-digest.sh YYYY-MM-DD` 或 `npm run digest:prepare -- YYYY-MM-DD`。从抓取开始时日期必须是北京时间当天；默认依次执行 LLM/API 抓取、筛选、多阶段全文分析、博客 generate/普通 LLM review/push 和视觉规划。脚本不调用图像 API，结束后 Codex 仍须用内置 `image_gen` 完成并验收 TOP 10 长图与汇总封面。`--api` 与 `digest:api` 保留为默认路线的显式同义入口；只有 `--manual` / `digest:manual` 才切换 production Manual v6。

用户说“运行/进行某日论文速递”时，默认已经授权博客 push，并要求完成上述全部阶段；不能在抓取、深度分析、review 或发布后提前停止。微信、飞书、小红书自动发布不在默认范围。

### 3.0 自动链路与人工接管链路

默认路径使用关键词预筛、模型筛选、多阶段 LLM 分析和普通三层 review。只有用户明确要求 Manual/人工流程时才切换 production Manual v6；两条路线都不会因对方的失败而静默改变 provenance：

> Production Manual v6 已是正式主链：全文阶段在 HTML `.text()` 前保存表格、MathML/TeX、图和 bibliography，只有结构 inventory 闭环时 ArtifactIndex 才 complete；PDF/text fallback 明确 incomplete。持久 runner 管理 author → technical_scoring / pedagogy_readability → author_revision，但不创建真实 subagent、不物化 packet，也不自动产出 records v4；这些仍由主 Agent完成。正式根为 `data/current/manual-v6/<date>/`，spec v6 经 `runtimeMode=production` 写标准 canonical；显式 shadow 使用 `manual-v6-shadow/<date>/`。v5 仅作显式历史只读/维护兼容。

- `manual-fetch.js --raw` 仍联网抓取 arXiv/HuggingFace，只是不调用筛选模型；同日期 raw/select/fulltext 共用跨进程锁。HF 使用异步 curl 子进程，不再阻塞事件循环；recent/search/abstract/Atom 的真实 arXiv 请求由同 host scheduler 串行，批次级 normalized ID Promise cache 避免跨类别重复摘要。`--select` 接收完整覆盖候选全集的 `manual_offline` v1 逐篇裁决，并把输入 SHA、reviewer 和协议指纹写入筛选四件套。
- `manual:fulltext` 持久化受控结构快照并按论文增量产出 companion ArtifactIndex。HTML 表格矩阵/rowspan/colspan、MathML/TeX、图和参考文献绑定原始 HTML、最终全文和单篇 input SHA；结构缺失、截断或 PDF/text fallback 只能写 `incomplete`，production v6 不得消费为完整证据。既有 v2/v5 字段仅作为 legacy 基础校验兼容。
- `manual:v5:author-packet` 仅是 legacy v5 历史维护输入封印器，不用于 production v6。正式 v6 runner 不自动物化 packet：主 Agent必须逐 role 调用 `manual:packet`，在 `manual-v6/<date>/task-runner/tasks/<paper>/` 准备 exact allowlist，随后 register/claim/start/submit；runner 不创建 subagent或正文。
- `manual-deep-analysis.js` 不调用 LLM/API；production v6 ingestion 重放 official spec v6 assembler，要求 `runtimeMode=production` 并写标准 canonical。records v4 内嵌并重放 legacy v5 base payload 作为基础质量子校验，同时增加 task packet/output/receipt、`reader-longform-v2`、ArtifactIndex、source identity 与 Merkle 绑定；records v3/spec v5 仅由 `manual:v5:*` 历史维护命令读取。
- 新 canonical 用 `manual-paper-source-identity-v1` 封印单篇全文 entry、图片、结构化快照与 ArtifactIndex 语义/文件 SHA。批次 manifest 的整文件 SHA 只服务集合完整性，不参与单篇复用；因此别篇 parser/checkpoint 更新不会误伤本篇，本篇证据变化仍 fail closed。带 fresh/tutorial marker 却缺该身份的记录不能按历史 v5 放行。
- `manual:spec`/`manual:v6:spec` 从 production records v4 envelope 回读所有单篇工件真实字节并组装 `manual_analysis_spec_v6`；`manual:analyze`/`manual:v6:analyze` 以 `runtimeMode=production` 写标准 `data/current/deep-analysis-result.json`。`manual:v6:shadow:spec/analyze` 才写 `data/current/manual-v6-shadow/<date>/`，且不更新正式 canonical 或 `papers.json`。
- `manual:tasks`/`manual:v6:tasks` 默认是 production 状态机：`init/register/claim/start/submit/fail/retry/abandon/status` 绑定 filtered、单篇根、packet/output/receipt 真实字节和 Terra-high provenance，最多 3 个活动 claim。`author_revision` submit 会在未封印状态完整重放 `reader-longform-v2`：blocks 必须逐字生成最终正文，`tables` / `figures` / `formulas` 逐项闭环，正文实际使用的 `terms` 全部定义，`relatedWorks` 至少绑定两个真实引用；旧 `*Coverage` 摘要不能代替正式字段。显式 retry/abandon 后只允许目标 packet 受控替换，其他节点仍逐字重验。附加 `--shadow` 才进入 shadow 根。runner 不访问 LLM/API，也不会替主 Agent创建 subagent、编写正文、物化 packet 或组装 records envelope。
- `manual:packet`/`manual:v6:packet` 只物化当前论文当前 role 的 exact allowlist，并输出可直接用于 runner `register` 的参数；`manual:records`/`manual:v6:records` 只在四角色全部 validated 后重开所有 packet/output/receipt，确定性注入初稿与终稿 lineage 并密封唯一 `records-v4.json`。两者都不调用 LLM/API。
- `manual:bind-revision`/`manual:v6:bind-revision` 只把单篇 Terra-high leaf 已完成的终稿、未封印 base payload 与 compact semantic map 确定性序列化为正式 longform/output/receipt：按标题拆 block、用 ArtifactIndex 替换手抄表格、从 runner validated technical/pedagogy 输出回填评分与可读性并重算全部 SHA；它不生成 prose，也不能替代审查 finding 的实质修订。
- 博客单篇灰度发布使用 generate、Manual attestation/review、push 全链路一致的 `--include-id`，禁止用普通 LLM review 代替显式 Manual 审查。已经通过 tutorial payload 密封的 fresh 页面必须额外给 generate 传 `--sealed-tutorial-preview`：生成器在读取 canonical 前分流，重放受控 manifest 与 article/quality/artifact-plan/编辑契约 SHA，逐字安装 `post.md`，并用不含旧 analysis/readerArticle 的快照建立 schema v3 generation；不得 sanitize 或生成汇总页。`blog:manual-plan` 输出按日期、规范化论文 ID 和身份哈希隔离的 shardDir/attestationPath；逐页 Terra-high shard、assembler、Manual receipt 和 push 只消费这一隔离作用域，不能回退日期整批文件。已有同日整批证据保持只读；单篇 staging/manifest 只能包含一个论文页，禁止汇总页、同日旧页删除和批次视觉任务。push 还要求博客仓库除该目标页外完全干净，防止夹带其他页面或配置变更。
- Production v6 records v4 内嵌并重放的 legacy v5 base payload 基础质量子校验不只靠字数：系统/方法论文至少 4 条 `resultClaims` 且跨至少 2 个实验组，连续原句绑定设置、方法、基线、指标、数值、单位和方向，并提供实际写入实验正文的自然语言 `readerNarrative`；v6 另要求 `reader-longform-v2` 与 task bindings。
- records v2/spec v4 与 spec v3 仅作历史兼容；新日更不得降级。v4 继续写 `full-text-evidence-v4`，v3 继续写 v3 + `bounded-v1`，均不追溯套用 v5。
- 最终 production v6 读者门禁覆盖作者与机构、毒舌点评、`reader-longform-v2` 的叙事和图片邻接、评分理由和开源详情；legacy v5 `readerArticle` 仅作为 records v4 内嵌基础质量子校验或历史只读版式。
- `manual-review-blog.py` 只在 LLM review 服务不可用时替代语义模型。新批次要求 v3 attestation（v2 仅历史兼容）；它要求对 generation 中每个现存文件绑定 SHA、批次内唯一且含页面标识的 notes、Terra-high 单页 reviewer provenance，并逐项确认标题、技术叙事、事实、实验、复现、局限、评分和图片；唯一性比较会剥离页面 ID、日期或删除文件名，拒绝仅替换标识符的批量模板；受控删除项则显式绑定 `deleted:true`、空 SHA、`deletionVerified` 和包含文件名的删除说明。脚本仍执行确定性复验、Git 基线、review 协议和 Hugo gate 绑定，若确定性层修改页面则旧 attestation 立即失效。输出图片审查模式为 `manual_semantic` 的 receipt，push 会重验逐文件 provenance 与远端 OID。

schema v3 generation 的页面 SHA/删除状态会在 review 开始、receipt 签发和 push 重验时统一与当前文件比较；generation 后改动任意字节都会在 LLM/Hugo 前失败。`content/posts` 的现存项和删除项都必须匹配目标日期；Manual durable provenance 还会重验 taskName 唯一性和论文页 paperId。

三种人工模式分别只替代对应模型职责，不绕过来源健康、正文质量、发布或视觉门禁。

### 3.1 自动归档

运行开始时，脚本检查 `data/current/` 下的以下文件：
- `raw-candidates.json`
- `filter-decisions.json`
- `deep-analysis-result.json`
- `filtered-papers.json`
- `analyzed.json`

**注意：`papers.json` 是去重数据库，不参与归档移走，持续累积。**

归档规则（逐文件判断）：
1. 读取文件中的时间戳字段（支持 `timestamp` / `lastUpdated` / `deepAnalysisCompletedAt` / `previousTimestamp`，筛选伴随文件也可由批次字段识别）
2. 若日期 **早于今天（北京时间）**，则复制到 `data/archive/<日期>/`
3. 若 canonical 归档已存在且内容一致，直接复用；若内容不同，先把旧 canonical 另存为带北京时间戳的冲突快照，再以 current 内容替换 canonical，并重新读取校验
4. 归档已确认一致，或旧版本留存且新 canonical 校验成功后，**删除** current 原文件；任一步失败则保留 current，避免数据丢失

此外，最终保存新的深度分析结果前，若已有 `deep-analysis-result.json` 且包含数据，会先备份到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并自动清理旧备份（保留最近 10 个）。这一步发生在分析完成后的最终保存阶段，不属于启动时的每日归档。

### 3.2 加载去重库与博客去重

运行开始时，首先加载去重集合：

1. **papers.json**：读取 `data/current/papers.json` 中已有的论文 ID
2. **博客已发布**：扫描 Hugo 博客仓库（`PAPER_DIGEST_BLOG_REPO`，默认 `~/code/github_repos/audio-paper-digest-blog`）的 `content/posts/` 目录，从所有 `.md` 文件中提取 `arxiv.org/abs/XXXX.XXXXX` 格式的 arXiv ID

两者合并为统一去重集合，后续 arXiv 抓取和 HuggingFace 抓取都会跳过集合中的已有 ID，**在抓取阶段就排除已发布论文，避免浪费 LLM API 调用。**

### 3.3 arXiv 抓取

从 7 个分类各抓取最新论文：

| 分类 ID | 名称 | 优先级 |
|---------|------|--------|
| `eess.AS` | 音频语音 | core |
| `cs.SD` | 声音 | core |
| `eess.SP` | 信号处理 | core |
| `cs.CL` | 计算语言学 | supplement |
| `cs.LG` | 机器学习 | supplement |
| `cs.AI` | 人工智能 | supplement |
| `cs.MM` | 多媒体 | supplement |

**抓取策略：recent 页面 → 搜索页 → API 三级**

1. **recent 页面（主要方式）**：
   - 从 `arxiv.org/list/{category}/recent` 页面抓取，支持翻页（`?skip=50&show=50`）；recent 路径固定最多两页/100 篇。`PD_ARXIV_MAX_RESULTS` 是最终每类目标数，目标高于 100 或 recent 不足时，严格分类 search 页面与 Atom API 继续补足
   - recent 页面限流策略宽松，优先使用
   - 抓取后自动补充摘要（`fetchAbstracts`）
   - 获取到足够论文后跳过后续步骤

2. **搜索页（备用）**：
   - recent 不足时，从 `arxiv.org/search/` 搜索页面补充
   - 每页 50 篇，支持分页获取
   - 使用 User-Agent 轮换，页面间延迟 10-25 秒

3. **API 补充（最后兜底）**：
   - 上两步均不足时，使用 `export.arxiv.org/api/query`
   - 429 限流指数退避：60s, 120s, 240s, 480s，最多 5 次重试
   - recent/search/摘要/Atom 请求统一具有 60 秒绝对截止时间和 8 MiB 响应上限；重试、退避和 User-Agent 全部由 `ARXIV_CONFIG` / `PD_ARXIV_*` 配置驱动

3. **抓取参数**：
   - `parseArxivXML()` 保留“连续 20 篇已知 ID”解析选项，但正式分页/API 补全路径为保证来源覆盖会显式关闭该提前停止，不把它当作当前抓取上限
   - 核心类别优先抓取，补充类别随机排序
   - 显式 Manual raw 不再在健康类别末尾固定等待：真实请求按 host 严格单飞，下一次同 host 请求采用健康 1 秒、瞬时失败 5 秒、429 60 秒的自适应冷却（另有至多 1 秒抖动），并继续服从单类累计重试预算；本地解析、checkpoint 和并行 HF 工作可抵消冷却。默认 API 流程仍保留原 `categoryDelayMs`，两条路线不要混写
   - 无新论文时继续运行而非终止

4. **终端输出**：
   - 显示每篇新论文的 arXiv ID 和标题
   - 显示搜索到的总篇数和去重后的篇数

去重逻辑：`deduplicatePapers()` 按 `arxivId` 去重，core 类别（eess.AS / cs.SD / eess.SP）优先于 supplement 类别保留。

### 3.4 HuggingFace Papers 抓取

通过 `fetch-huggingface-papers.js` 双源抓取：

1. **`/api/daily_papers`**：精选每日论文，含 `ai_summary`、`githubRepo`、`upvotes`、`ai_keywords`、`projectPage`、`githubStars`、`discussionId` 等丰富字段。分页获取（`limit=100`，最多 20 页），直到越过截止日。默认 `days=7` 以“北京时间今天减 7 天”为含端点截止线，因此保留今天及此前 7 个日历日期，而不是只有 7 个日期。
2. **`/api/papers`**：最新论文补充，覆盖最近 1-2 天，用于补充 daily_papers 未收录的新论文。

过滤：
- 只保留闭区间窗口内的论文（`published >= 今天-7天`，因此包含截止日与今天两个端点）
- 排除历史已有 ID（papers.json 中已完成/已发布论文、博客已发布 ID）
- **不排除本轮刚抓取的 arXiv ID**：同批重叠论文会进入合并阶段，用 HF upvotes、AI 摘要、项目页等字段补齐 arXiv 元数据
- 按 `upvotes` 降序排列

技术实现：使用 `curl` 命令获取数据（避免 Node fetch 在代理环境下的兼容问题），返回数据标准化为与 arXiv 一致的字段结构。HuggingFace 抓取必须经项目 `.env` 的代理，缺失代理配置会立即失败而非生成空批次。

### 3.5 合并去重与博客过滤

`mergeAndDeduplicate(arxivPapers, hfPapers)` 的规则：

- **arXiv 论文优先级更高**：先全部放入 `merged` Map，保留其 `categories`、`abstract` 等元数据
- **HF 论文补充**：若 HF 论文的 `arxivId` 已存在于 arXiv 论文中，合并全部 7 个 HF 特有字段；若不存在，作为独立论文加入
- **来源标记**：`sources: ['arxiv']`、`['huggingface']` 或 `['arxiv', 'huggingface']`
- **摘要统一**：HF 论文同时输出 `summary` 和 `abstract`（内容相同），确保下游无需区分字段名

合并后，过滤掉博客已发布论文（基于第 3.2 步加载的博客 ID 集合），确保已发布论文不会进入 LLM 筛选阶段。

HF 特有字段（共 7 个）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hf_upvotes` | number | HF 社区点赞数 |
| `hf_ai_summary` | string | HF AI 生成的摘要 |
| `hf_ai_keywords` | string[] | HF AI 提取的关键词 |
| `hf_github_repo` | string | 关联 GitHub 仓库 |
| `hf_project_page` | string | 项目主页 |
| `hf_github_stars` | number | GitHub Stars 数 |
| `hf_discussion_id` | string | HF Discussion ID |

### 3.6 LLM 筛选

使用 `项目根目录的 `.env` 文件` 中的 `PAPER_ANALYZER_*` 配置逐篇判断是否为语音/音乐/音频相关。

**API 协议自动路由**：`scripts/utils.js` 中的 `detectApiType()` 会根据端点和模型名自动切换 OpenAI Chat / OpenAI Responses / Anthropic 协议；`muse-spark-1.2-contributor` 使用 OpenCode Go `/v1/responses`

LLM endpoint 只允许 HTTPS；仅 loopback 本地测试服务可以使用 HTTP，避免把 API key 发送到公网明文连接。
- **OpenCode Go Muse Spark Contributor**：精确模型 `muse-spark-1.2-contributor` 使用 OpenAI Responses 协议；`https://opencode.ai/zen/go/v1` 自动转换为 `/v1/responses`，且必须走项目 HTTP CONNECT 代理
- **MiMo/Kimi Token Plan / Coding Plan**（MiMo 由 `token-plan` + MiMo 域名/模型识别；Kimi 由 `coding` + `kimi.com` 域名或 Kimi 模型识别）→ 自动切换为 **Anthropic 协议**，兼容 `k3`，并伪装成 Claude Code 调用
  - **MiMo**: `https://token-plan-cn.xiaomimimo.com/v1` → `/anthropic/v1/messages`
  - **Kimi**: `https://api.kimi.com/coding` 或 `https://api.kimi.com/coding/v1` → `https://api.kimi.com/coding/v1/messages`（自动补齐 `/v1`，无需 `/anthropic` 中间路径；兼容 `k3` 等模型名）
  - Headers: `x-api-key` + `anthropic-version: 2023-06-01` + `User-Agent: claude-cli/<version> (external, cli)`（版本号动态获取自本地 `claude --version`，失败回退到 `2.1.108`）
  - system message 自动提取为请求体顶级字段
- **其他情况**（包括 MiMo 按量付费 `api.xiaomimimo.com` 、通用 OpenAI 端点）→ 使用标准 **OpenAI 协议**
  - URL: `/v1/chat/completions`
  - Headers: `Authorization: Bearer {key}`

筛选 prompt 从 `prompts/filter.md` 读取，运行时替换 `{title}`、`{abstract}`、`{categories}` 占位符。判定标准如下：
- 语音合成/识别/增强/分离/克隆/转换 → **是**
- 音频生成/理解/音乐/事件检测 → **是**
- 说话人相关任务 → **是**
- 语音/音乐/音频相关模型、表示学习、预训练 → **是**
- 多模态模型只要明确涉及语音/音乐/音频（输入、输出、训练目标、评测任务或核心能力之一）→ **是**
- 其他领域且没有实质性语音/音乐/音频方法或任务 → **否**
- 冲突处理：若同时看起来满足"多模态涉及语音/音乐/音频"和"其他领域"，优先判定为 **是**

运行参数：
- `batchSize = 5`（批内并行调用 LLM）
- `delayBetweenBatches = 2000`（批次间延迟 2 秒）
- `useKeywordPreFilter = true`（默认在 LLM 前执行高召回本地预筛；核心音频类别提供兜底）
- 单篇超时 **60 秒**，重试 **5 次**（退避 `2^attempt * 1s`）
- 每次请求使用 Node 请求销毁机制同时执行 socket 空闲超时、绝对截止时间和响应字节上限；深度分析的 20 分钟总预算按进程活跃时间扣减，系统睡眠不计入 API 用时

筛选阶段会增量保存三类文件：
- `data/current/raw-candidates.json`：合并和博客去重后的候选输入，并包含 arXiv/HF 的 `sourceHealth`、请求次数、成功次数和失败明细。抓取器区分真实成功空响应与全请求失败；所有尝试均失败时抛错并中止，禁止生成伪成功空批次
- `data/current/fetch-checkpoint.json`：按 arXiv 类别和 HuggingFace 来源原子保存完整响应、健康状态、固定类别顺序与不可变历史去重基线。中断后只补跑失败来源；HTTP 200 但结构签名或解析覆盖异常也按来源失败处理
- `data/current/filter-decisions.json`：逐篇 LLM 决策缓存，绑定实际 fenced prompt、模型端点/协议/温度/输出配置与解析契约；API 错误或无法判断记为 `retryable`。健康 raw 即使没有任何决定也可直接续跑，配置变化只重筛、不重抓
- `data/current/filtered-papers.json`：阶段性/最终筛选输出；包含 `filterModel` 和 `filterPromptHash`。`status: "filter_complete"` 只表示逐篇筛选已完成但归档去重尚未完成，最终可跳过抓取/筛选的状态必须是 `status: "complete"`，且模型/hash 必须匹配当前配置

若今天已经存在完整且模型/hash 匹配的 `filtered-papers.json`，再次运行 `node scripts/full-fetch.js` 会跳过抓取与筛选，直接进入深度分析续跑；若筛选尚未完成，但同日 `raw-candidates.json` 显示所有来源健康且模型/hash 匹配，则跳过抓取，只复用候选与明确决策、重试未决论文。来源失败时才禁止该续跑，必须恢复缺失来源。

关键词预筛的回归门禁为 `npm run keyword:recall`：人工金标同时覆盖音频正样本和高相似度负样本；历史回放中的已知 LLM 误筛必须显式裁决，报告分别显示未经裁决命中率与裁决后有效正样本召回率，禁止用历史误筛污染有效召回口径。
`npm run validate:data` 会同时校验 fetch checkpoint 的来源结构/状态，以及 checkpoint、raw、decisions、filtered 的同批次指纹、候选统计和完整覆盖。

### 3.7 深度分析

使用 `deep-analyzer.js` 对每篇筛选后的论文进行全文 + 图片的深度阅读理解。

深度分析 prompt 从 `prompts/deep-analysis.md` 读取，运行时替换 `{hasFullText}`、`{title}`、`{authors}`、`{categories}`、`{arxivId}`、`{textForAnalysis}` 占位符。

**自动 API 路线的 canonical 分析内容（由 LLM 生成，中文输出）**：

> 这些固定标题是自动 API 输出的解析锚点。Production v6 发布使用 `reader-longform-v2`；legacy v5 的 `readerArticle` 版式仅用于 records v4 内嵌基础质量重放或历史只读兼容。

| 章节 | 要求 |
|------|------|
| 评分 | `type-aware-v1`：先输出 `document_type`（方法研究/系统技术报告/模型报告/数据集与基准/综述/理论研究/应用研究），再按对应证据标准评分；机器摘要另含 `rank_bucket`、八维分项和 `confidence`。八维合计满分 11，总分封顶 10；只有八项完整、唯一、分母和范围合法时才从 `## 评分理由` 重算总分，否则契约失败。类型不固定加分，同一缺陷只能在一个主要维度扣分 |
| 标签 | 3-5 个，必须含至少 1 个【任务】和 1 个【方法/模型】标签；除最终标签串外，还要求输出"主任务标签""主方法标签""补充标签" |
| 作者与机构 | 第一作者、通讯作者、作者列表及所属机构；缺失信息必须写"未说明"，禁止猜测 |
| 毒舌点评 | 由深度解读的机制、实验与边界支撑的双向点评：production v6 长文与其内嵌的 legacy v5 base payload 都必须覆盖优点和不足，尖锐但不情绪化 |
| 核心摘要 | 5-8 句话，覆盖问题、方法、效果、局限性 |
| 方法概述和架构 | 输入输出流程、组件结构、连接方式、设计理由；不少于 600 中文字符 |
| 核心创新点 | 3-5 个，每个含定义、之前方法的不足、解决机制、实际效果 |
| 实验结果 | 必须优先给出 benchmark、指标和具体数字；拿不到数字时明确写"论文未给出具体数值"；表格必须完整输出 |
| 细节详述 | 训练数据、损失函数、训练策略、超参数、硬件、推理细节 |
| 评分理由 | 按 8 个维度分别给分（创新性/2、技术严谨性/1.5、实验充分性/1.5、清晰度/1、影响力/1.5、开源/1.5、可复现性/0.5、工程/实践价值/1.5），严禁使用 10 分制，代码自动从评分理由提取分项重新计算总分 |
| 局限与问题 | 分两部分：论文明确承认的局限 + 审稿人发现的潜在问题 |
| 开源详情 | 只允许基于论文文本或当前输入链接总结，缺失时写"未提及"，禁止编造仓库/热度信息 |

> **图片与表格放置规则**：production v6 必须把图、表、公式的确定性处置写入 `reader-longform-v2` block；records v4 内嵌的 legacy v5 base payload 仍重放其 `readerArticle` 图片邻接作为基础质量子校验。严禁编造图片 URL。

**技术特性**：
- **API 协议自动路由**：与筛选阶段共用同一套 `detectApiType()` 逻辑，根据 `PAPER_ANALYZER_ENDPOINT` 和 `PAPER_ANALYZER_MODEL` 自动切换 OpenAI Chat / OpenAI Responses / Anthropic 协议。`muse-spark-1.2-contributor` 使用 OpenCode Go `/v1/responses`
- 获取 arXiv HTML/PDF 全文；主分析默认最多使用 200K 字符，超长来源由 `task-focused-v1` 按开头、四分位、中部、尾部和任务关键词跨全文确定性取样，而不是简单截取前缀。依次尝试 `v1`、`v2`、无后缀版本；所有 HTML/PDF/图片请求均通过项目 `.env` 的 HTTP CONNECT 代理 dispatcher，缺失配置即失败；使用 **cheerio** 结构化解析 HTML，移除 script/style/nav/header/footer 等噪音元素
- 提取图片 URL，过滤 logo/favicon；下载层会校验 Content-Type、Content-Length 和 PNG/JPEG/WebP 文件头，避免把 HTML 错误页或过大图片送入模型
- **图片分析**：HTML 正文和 figure caption 同次解析，预提供 URL 用同 URL 或唯一文件名补全图注。候选按 caption/文件名/顺序预筛后串行下载，成功内容写入 `data/current/image-cache/`；404、错误 MIME、超限和安全拒绝不重试，只有限流、服务端错误和网络异常重试。副模型按价值排序输出最多 4 张计划，并从代码提供的段落目录选择稳定 `paragraph_id`；旧自由文本 anchor 只兼容历史响应。非法 ID、定位失败和超限图片不会回退到章节末尾
- 每篇结果会保存 `imageManifest`：包含候选评分、逐 URL 下载结果、缓存命中、副模型/温度、prompt/响应哈希、插入与拒绝诊断及最终选图。严格空计划为 `no_high_value_images`；全部永久不可下载为 `no_downloadable_images`；有计划但零插入为 `invalid_output` 并只重试插图阶段
- `analysisManifest` 记录图片下载、主分析、开源扫描、Demo 扫描、审校、表格/方法/结构修复、评分审计、API 读者文章和插图阶段；失败时保留 `analysisCheckpoint` 与 `analysisRecoveryImageManifest`。再次运行从首个未完成阶段继续，只有所有必需阶段进入完成/无需/跳过等终态才视为成功
- **并发度：3 篇并行**（可通过项目 `.env` 中的 `PD_ANALYSIS_CONCURRENCY` 调整）
- 每篇默认最多重试 **2 次**（外层 `analysis-engine.js`，由 `PD_ANALYSIS_MAX_RETRIES` 调整）；每次外层尝试中的每个 LLM API 阶段默认最多尝试 **3 次**（`deep-analyzer.js` 内层，由 `PD_ANALYSIS_API_MAX_RETRIES` 调整，指数退避：第一次等待 10 秒，之后翻倍，`2^attempt * 5000ms`），外层重试间隔 3 秒
- API 整体超时为 **20 分钟活跃时间**；每秒心跳识别超过 30 秒的系统睡眠/事件循环挂起并排除该墙钟跳变，唤醒后的请求超时仍按剩余预算重试
- 主分析 `max_tokens=64000`（config.js 中 `apiMaxTokens`）；审校/表格/方法/结构局部修复默认 `max_tokens=16000`（`repairMaxTokens`，可由 `PD_ANALYSIS_REPAIR_MAX_TOKENS` 覆写）；`temperature=0.7`
- 各后处理阶段不再重复发送整篇论文：开源扫描、审校重写、评分审计、方法/表格修复和结构修复的默认证据预算依次为 16K、60K、40K、30K、40K 字符。对应 `.env` 变量为 `PD_OPENSOURCE_EVIDENCE_MAX_CHARS`、`PD_REVISION_EVIDENCE_MAX_CHARS`、`PD_SCORING_EVIDENCE_MAX_CHARS`、`PD_REPAIR_EVIDENCE_MAX_CHARS`、`PD_STRUCTURE_EVIDENCE_MAX_CHARS`；主分析预算由 `PD_ANALYSIS_FULL_TEXT_MAX_CHARS` 控制。选择算法版本与预算进入恢复指纹，变化时只重跑受影响阶段及下游
- 每次模型调用日志记录文本字符数、估算文本 token 数与图片数；图片 base64 不计入也不写入文本统计
- 代理只从项目根 `.env` 中显式配置的大小写代理变量读取；不继承 shell/IDE 代理，也不读取 macOS `scutil`。arXiv 抓取至少需要 `HTTPS_PROXY` 或 `HTTP_PROXY` 其中一项 HTTP CONNECT 地址，HuggingFace `curl` 可额外使用 SOCKS `ALL_PROXY`
- LLM 请求与抓取请求完全隔离：LLM 默认 `agent:false` 直连；精确模型 `muse-spark-1.2-contributor` 是唯一例外，必须使用项目 `.env` 的 HTTP CONNECT 代理并为每次请求创建独立 agent。它不复用抓取 dispatcher，也不允许缺代理直连；使用本机代理的网络命令必须在沙箱外运行
- 抓取阶段只要任一 arXiv 类别或 HuggingFace 来源失败，即写入 `source_partial_failed` 并终止在筛选阶段；此状态不能复用为 `filter_complete`，也不能进入深度分析或更新持久化去重库。
- 所有分析配置集中管理于 `scripts/config.js`，支持项目 `.env` 覆写（并发、重试、arXiv/PDF 超时与大小、各阶段证据字符预算、评分审计温度、插图计划温度及图片预算）

**深度分析不是单次调用，而是多轮递进式处理**：

| 轮次 | 名称 | Prompt | 作用 |
|------|------|--------|------|
| Round 1 | 主深度分析 | `prompts/deep-analysis.md` | 主模型对**全文纯文本**分析，生成所有章节 |
| Round 2 | 开源扫描 | `prompts/opensource-scan.md` | 从论文文本提取 GitHub/HF/ModelScope 等链接，补充开源详情 |
| Round 2.5 | Demo 页链接发现 | 代码抓取 | 若无开源链接，访问分析中出现的 demo 页（最多 3 个），每页最多安全跟随 3 跳且逐跳重验公网地址，从中回捞代码/模型/数据集链接 |
| Round 3 | 审校重写 | `prompts/gap-fill.md` | 对比原始论文与前几轮输出，修正缺失、错误、过度推断 |
| Round 4 | 表格修复 | 代码检测 + LLM 补充 | 检测实验结果章节缺失的 Markdown 表格，触发补充 |
| Round 5 | 方法章节修复 | 代码检测 + LLM 补充 | 检测方法概述是否过于简略（<600 字/<3 段），触发扩展至 600+ 字 |
| Round 6 | 最终结构修复（按需） | `prompts/structure-repair.md` | 共享契约发现 13 个必要章节有缺失时，主模型只补齐当前报告结构；完整时不调用 |
| Round 7 | 类型感知评分审计 | `prompts/scoring-audit.md` | 主模型只输出 JSON；代码把校验错误反馈给下一次局部审计，并按资源状态确定性归一化无产物论文的开源分 |
| Round 7.5 | 初学研究者读者文章 | `prompts/api-reader-article.md` | 在事实与评分闭环后按学习依赖重组为动态小节长文；代码校验篇幅、标题、逻辑顺序、去模板和 SHA 闭环 |

表格后处理会在全文存在编号表但正文缺少可读表、已有表只有叙述型结论卡/证据过浅，或出现“此处省略/详见原文”等非法占位语时调用。新分析和重分析写入 `analysisManifest.contracts.experimentTables=evidence-rich-v2`：除每篇最多 2 张表、每表最多 12 行和 8 个指标列外，还要求标识列、至少 3 行与 2 个数字、指标方向、表前具体比较问题、表后关键差异与证据边界，并在来源提供时覆盖消融或负面证据。Node 与 Python 双端同构校验；历史 `bounded-v1` 仍只执行旧上限门禁。
| Round 8 | 图像筛选与插图计划（仅双模型模式） | `prompts/image-supplement.md` | 副模型只输出 JSON 插图计划；合并后再次校验完整契约，不合格时只丢弃插图计划并保留主模型正文 |

评分审计全部通过后，先依次运行 `generate-blog.py`、`review-blog.py` 和 `push-blog.py`，发布汇总页及全部论文页。博客文本 review 默认按 8000 字符分块（`PD_BLOG_REVIEW_CHUNK_CHARS`，范围 4000–16000），减少每块重复的固定说明；分块仍保持 Markdown 块边界，且值进入整批审查凭证指纹。已通过页面另以博客仓库相对路径 + SHA-256 持久保存，因此分块、review 代码或其他协议元数据变化只刷新整批凭证，不会重审字节未变的页面。完全相同的非空 generation 可安全重跑三阶段：review 仅在当前协议、页面字节、发布提交、remote 名称/push URL 哈希和实时远端 `main` OID 全部仍匹配时保留已发布 receipt；push 再次验真，不创建无差异提交。网络故障、远端分支漂移或 `origin` 换仓均拒绝复用。`push-blog.py` 只有在远端 `main` OID 与 `publicationCommit` 完全一致后才写入远端验证字段，并自动调用 `visual-summary-integration.js`。规划器按最终评分降序、同分规范化 arXiv ID 升序选取 TOP 10；Codex 读取 `prompts/visual-summary.md`，为每篇生成一张顶部英文标题、正文中文的纵向长图，并用 task token 登记。

同一发布后阶段还会按博客 generation manifest 保存的 category 建立一张批次汇总图任务，内容为标题、热门方向和 TOP 10 排名。两类 manifest 分别保存发布提交、数据 SHA、prompt SHA、task token 与资产 SHA，中断后只补缺失、失败、损坏或失效项。论文长图任务还会从深度分析的 `selectedImageUrls` / `imageManifest` 中选择最多两张已下载且 URL、MIME、字节数和 SHA 全部匹配的关键原图，优先方法总览、架构和流程图，再考虑关键实验图；参考图指纹变化只失效对应论文。内置生图必须把参考图作为结构事实来源重新绘制，不得粘贴不可读截图或补造原图中没有的数据。同批次全部图片扁平归档到 `data/archive/<日期>/visual-summaries/`：封面为 `00-digest-cover-<日期>.png`，论文长图按 manifest 最终排名命名为 `<两位排名>-<paper-id>-<title-slug>.png`，并发完成顺序不参与编号。旧版 current 与旧归档目录结构会在 plan 时经 PNG/SHA 校验后迁移。图片不进入已经发布的博客清单，也不阻断博客流程；项目脚本不得调用图像 API，生成图不得冒充论文原始 Figure 或虚构事实，汇总图不得显示 arXiv ID。

调用内置生图前必须运行 `npm run visual:prepare -- --date <日期>`。该命令不会调用图像 API，也不会改变任务 token；它重新校验 `.bin` 原始缓存的受控路径、SHA、长度、MIME 与文件头，随后把参考图原子物化为 `data/current/visual-reference-inputs/<日期>/<排名-论文>/` 中带正确扩展名的文件。生图时使用命令输出的绝对 `referencedImagePaths`，不要把 `.bin` 或仅供展示的 `relativePath` 直接传给图片服务。可用 `--paper <ID>` 只准备单篇，重复运行会校验并修复被改写的物化文件。

视觉 plan/status 默认只输出每个任务的排名、论文 ID、标题、task token、参考图数和 manifest 绝对路径；`visual:prepare` 保留生图必需的绝对 `referencedImagePaths`。完整 `generationContext.qaClaims` 与封面排行仍在 manifest 内。`digest:status` 终端只打印各阶段数量摘要，完整 `sourceHealth` 仍写入 `digest-run-reports/<date>.json`。该 JSON 是命令执行时的只读验收快照；后续 push、视觉规划或 `record` 不会反向更新旧报告，读取当前终态前必须重新运行命令。历史日期可从同日 archive 读取 raw/decisions/filtered/deep，但 decisions 必须完整覆盖 raw、filtered 必须精确等于相关决定扣除显式排除项、全部论文必须属于目标批次且 deep 不得混批；缺失或语义损坏保持 incomplete。当前日期严格只认 current。

> **单模型 vs 双模型**：主模型始终负责正文和最终评分审计。评分审计默认使用独立低温 0.1。设置 `PAPER_ANALYZER_SECONDARY_MODEL` 后，副模型只从候选图片中筛选高价值图、丢弃低信息图并输出章节、稳定段落 ID、图前和图后说明；代码不会接受副模型替换主模型原文。未设置副模型时图片 URL 只保存在候选元数据中，博客 review 的可选多模态 LLM 检查也会跳过，但确定性图片门禁仍执行。

评分审计的“单一问题单一维度”规则是硬校验。跨维度理由会触发带精确错误反馈的局部重试，而不会立即重跑前面的全文分析。审计 JSON 还要提交引用证据账本的 `evidenceProfile`；代码对多组件无直接消融、内部评测未报告样本规模、只有工程主张而无测量/可复用产物等情况应用分项或总分上限。评分契约、cap 规则版本、audit/output SHA 都进入恢复校验，代码规则变化不会复用旧评分。开源状态能由机器摘要与 `## 开源详情` 确定时，代码使用固定锚点：肯定语境明确承诺未来开放 0.5、带 URL 或肯定结构化状态的 Demo 0.2、否定/未提及且无承诺 0；理论研究根据公开证明、推导和附录判断核心产物，不机械要求代码/模型/数据链接。

全文获取会记录 `analysisSource`、字符数、截断状态、来源 SHA-256 和告警。HTML/PDF 均不可用时使用摘要并标记 `degraded_abstract`；该结果默认不能发布，只有人工设置 `allowAbstractAnalysisPublish: true` 后才允许生成带降级提示的博客。来源、评分模型、低温、评分 prompt 或证据指纹变化会精确失效对应 checkpoint，避免混用旧证据。

### 3.8 增量保存与收尾

- **每篇分析成功或失败后立即增量保存**到 `data/current/deep-analysis-result.json`；分析结果和 `papers.json` 在跨进程锁内重读最新 canonical、合并并把 `generation` 递增 1，避免多个入口并发丢更新。这里没有调用方携带 expected-generation 的锁外乐观比较。失败结果不会覆盖已有成功 `analysis`，当前 JSON 损坏时会阻断而不是回退旧文件覆盖
- `full-fetch.js` 用单实例运行锁覆盖归档、清理、筛选和最终合并；每篇分析在共享论文锁内重新读取最新规范记录后保存。批次回调与收尾只更新顶层统计，禁止用累计旧快照二次覆盖论文正文；失败 checkpoint 仍逐篇保留
- 增量保存和最终保存都会通过 `scripts/digest-status.js` 同步 `data/current/papers.json` 的 `digestStatus.status`，成功为 `analyzed`，失败为 `analysis_failed`
- 全部论文分析完毕后，再次读取已有结果，按 `arxivId`/`paper_id` 去重合并，保留历史数据
- 自动备份旧文件到 `data/archive/deep-analysis-result-<时间戳>.bak.json`，并清理旧备份（保留最近 10 个）
- **`papers.json` 自动备份**：每天运行前自动备份 `data/current/papers.json` 到 `data/archive/papers-<日期>.json`，保留最近 7 天
- 更新 `data/current/papers.json` 去重库
