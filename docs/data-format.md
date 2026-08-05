# 数据文件格式

## 数据文件格式详解

### 5.1 `data/current/papers.json`

论文去重数据库。**此文件不归档，持续累积。** 结构：

```json
{
  "papers": {
    "arxivId-1": {
      "arxivId": "2604.12345",
      "title": "论文标题",
      "abstract": "摘要...",
      "authors": ["Author A", "Author B"],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": ["cs.SD", "eess.AS"],
      "fetchedFrom": "eess.AS",
      "fetchedAt": "2026-04-21T10:00:00+08:00",
      "digestStatus": {
        "status": "seen | pending_analysis | analyzed | analysis_failed",
        "batchDate": "2026-04-21",
        "updatedAt": "2026-04-21T10:00:00+08:00",
        "filterDecision": true,
        "filterModel": "mimo-v2.5",
        "filterPromptHash": "a1b2c3d4e5f6a7b8",
        "filterDecidedAt": "2026-04-21T10:02:00+08:00",
        "latestAttemptStatus": "analyzed | analysis_failed",
        "error": null
      }
    }
  },
  "lastUpdated": "2026-04-21T10:00:00+08:00"
}
```

`pending_analysis` 和 `analysis_failed` 不参与下一次 `full-fetch` 的强去重，因此分析中断或失败后可自然重跑；成功分析后更新为 `analyzed`。`full-fetch.js`、`deep-analysis-only.js`、`reanalyze.js`、`batch-analyze.js`、`reanalyze-selected.js`、`analyze-single-paper.js` 和 `refilter-reanalyze-by-date.js` 都通过 `scripts/digest-status.js` 同步该状态，避免不同入口写法分叉。若最新一次尝试失败但已有旧的成功分析可用，`status` 保持 `analyzed`，并用 `latestAttemptStatus: "analysis_failed"` 与 `error` 记录这次失败；失败写回不会把已有成功 `analysis` / `parsed` / 图片元数据覆盖为空。

### 5.2 `data/current/fetch-checkpoint.json`

逐来源抓取 checkpoint。每个 arXiv 类别与 HuggingFace 保存 `status`、论文数组、`papersCount`、稳定 `papersSha256` 和 `health`；内容篡改或截短只使对应来源失效。固定类别顺序、不可变历史去重基线、候选指纹与北京时间批次日期必须和 raw/decisions/filtered 一致。只有全部必需来源结构和覆盖完整时才能进入筛选。

### 5.3 `data/current/raw-candidates.json`

当日 arXiv + HuggingFace 合并、博客已发布过滤后的筛选输入。用于排查“为什么某篇论文进/没进筛选”。结构：

```json
{
  "timestamp": "2026-04-21T10:00:00+08:00",
  "stats": {
    "beforeBlogSkip": 520,
    "afterBlogSkip": 480,
    "skippedFromBlog": 40,
    "arxivOnly": 420,
    "hfOnly": 45,
    "both": 15
  },
  "sourceHealth": {
    "arxiv": {
      "totalFetched": 273,
      "categories": [
        {
          "id": "cs.SD",
          "fetched": 50,
          "newInCategory": 44,
          "duplicateInCategory": 6,
          "durationMs": 12000,
          "ok": true
        },
        {
          "id": "cs.CL",
          "fetched": 0,
          "durationMs": 60000,
          "ok": false,
          "error": "HTTP 429"
        }
      ]
    },
    "huggingface": {
      "ok": true,
      "fetched": 51,
      "durationMs": 1800
    }
  },
  "papers": []
}
```

抓取器在 `sourceHealth` 中记录请求次数、成功次数和失败明细。某个来源的所有请求都失败时属于致命错误，不能表示成“成功但零篇”；至少一次请求成功后返回的空结果才是合法空批次，其他补充请求失败只保留为诊断信息。

`npm run validate:data` 会检查 `papers` 数组、`sourceHealth` 基本形状，并要求 `stats.afterBlogSkip` 等于候选论文数量、`stats.skippedFromBlog` 等于博客去重前后差值、`stats.arxivOnly + stats.hfOnly + stats.both` 等于博客去重前候选总量。

### 5.4 `data/current/filter-decisions.json`

LLM 筛选逐篇决策缓存。每批筛选后增量写入；重跑时只复用同模型、同 prompt 的明确布尔决定。API 错误或无法判断的响应单独记为 `retryable` 诊断，不能进入正式决定缓存，也会阻止 `stats.complete=true`。
`npm run validate:data` 会检查 `stats.decided` 是否等于 `decisions` 数量、`stats.related` 是否等于 `related: true` 数量，并要求每条决策的 `related` 为布尔值，`reason` / `rawResponse` / `parseSource` 等字段为字符串。若 `stats.complete=true`，还会要求 `decisions` 覆盖 `raw-candidates.json` 中的全部候选论文。

```json
{
  "timestamp": "2026-04-21T10:05:00+08:00",
  "filterModel": "mimo-v2.5",
  "filterPromptHash": "a1b2c3d4e5f6a7b8",
  "stats": {
    "totalCandidates": 480,
    "decided": 120,
    "related": 26,
    "complete": false
  },
  "decisions": {
    "2604.12345": {
      "id": "2604.12345",
      "paper_id": "2604.12345v1",
      "title": "论文标题",
      "related": true,
      "reason": "论文包含语音识别任务和音频实验",
      "rawResponse": "理由：论文包含语音识别任务...\n结论：相关",
      "parseSource": "conclusion_line",
      "decidedAt": "2026-04-21T10:05:00+08:00",
      "filterModel": "mimo-v2.5",
      "filterPromptHash": "a1b2c3d4e5f6a7b8"
    }
  }
}
```

### 5.5 `data/current/filtered-papers.json`

筛选结果（仅元数据，无深度分析）。结构：
新格式 `status` 允许值为 `filtering`、`filter_complete`、`complete`，并必须包含 `filterModel` 与 `filterPromptHash`。其中 `filter_complete` 是逐篇 LLM 筛选完成但尚未完成归档去重的临时状态；只有 `complete` 且模型/hash 与当前配置一致时，主流程才会在当天重跑时跳过抓取/筛选并直接续跑深度分析。早期没有 `status` 的旧对象格式不会触发跳过抓取/筛选，`npm run validate:data` 会提示补齐或重生成。

```json
{
  "timestamp": "2026-04-21T10:00:00+08:00",
  "status": "complete",
  "filterModel": "mimo-v2.5",
  "filterPromptHash": "a1b2c3d4e5f6a7b8",
  "stats": {
    "beforeFilter": 500,
    "beforeBlogSkip": 500,
    "afterBlogSkip": 450,
    "afterFilter": 450,
    "afterArchiveSkip": 450,
    "skippedFromBlog": 50,
    "skippedFromArchive": 0,
    "arxivOnly": 400,
    "hfOnly": 50,
    "both": 0,
    "decisionCount": 450
  },
  "sourceHealth": {
    "arxiv": {"totalFetched": 273},
    "huggingface": {"totalFetched": 51}
  },
  "papers": [
    {
      "arxivId": "2604.12345",
      "title": "...",
      "abstract": "...",
      "authors": [...],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": [...],
      "fetchedFrom": "eess.AS",
      "fetchedAt": "2026-04-21T10:00:00+08:00",
      "sources": ["arxiv"],
      "hf_upvotes": 0,
      "hf_ai_summary": "",
      "hf_ai_keywords": [],
      "hf_github_repo": "",
      "hf_project_page": "",
      "hf_github_stars": 0,
      "hf_discussion_id": ""
    }
  ]
}
```

`complete` 状态必须满足：
- `filterModel` 和 `filterPromptHash` 存在，用于判断同日筛选结果是否可被当前配置安全复用
- `filterModel` / `filterPromptHash` 与 `filter-decisions.json` 根字段一致
- `stats.afterBlogSkip` 等于 `filter-decisions.json.stats.totalCandidates`
- `stats.decisionCount` 等于 `filter-decisions.json.decisions` 数量
- `stats.afterFilter` 等于 `filter-decisions.json` 中 `related: true` 的数量
- `stats.afterArchiveSkip` 等于最终 `papers.length`
- 当 `stats.afterBlogSkip` 大于最终 `papers.length` 时，必须保留同批次 `raw-candidates.json` 以便审计筛选输入全集

这些约束由 `npm run validate:data` 只读检查，避免筛选缓存损坏后被续跑流程误用。

### 5.6 `data/current/deep-analysis-result.json`

核心分析结果。结构：

```json
{
  "generation": 12,
  "timestamp": "2026-04-21T10:00:00+08:00",
  "previousTimestamp": "2026-04-20T10:00:00+08:00",
  "stats": {
    "arxivFetched": 200,
    "hfFetched": 50,
    "totalMerged": 230,
    "afterFilter": 28,
    "newlyAnalyzed": 28,
    "preservedExisting": 15,
    "totalAfterMerge": 43,
    "arxivOnly": 20,
    "hfOnly": 5,
    "both": 3,
    "reanalyzed": 28,
    "reanalyzeFailed": 0,
    "reanalyzeAt": "2026-04-21T12:00:00+08:00",
    "selectedReanalyzed": 2,
    "selectedReanalyzeFailed": 0,
    "selectedReanalyzeAt": "2026-04-21T12:30:00+08:00"
  },
  "papers": [
    {
      "arxivId": "2604.12345",
      "title": "...",
      "authors": [...],
      "published": "2026-04-20T00:00:00+08:00",
      "categories": [...],
      "sources": ["arxiv"],
      "hf_upvotes": 0,
      "hf_ai_summary": "",
      "hf_ai_keywords": [],
      "hf_github_repo": "",
      "hf_project_page": "",
      "hf_github_stars": 0,
      "hf_discussion_id": "",
      "analysis": "## 评分\n8.5/10\n\n## 标签\n...",
      "scoringRubricVersion": "type-aware-v1",
      "parsed": {
        "score": "8.5",
        "documentType": "模型报告",
        "scoringRubricVersion": "type-aware-v1",
        "tags": ["#语音合成", "#扩散模型", "#多语言"],
        "authors": "...",
        "roast": "...",
        "summary": "...",
        "architecture": "...",
        "innovation": "...",
        "details": "...",
        "results": "...",
        "scoringReason": "...",
        "opensource": "...",
        "machineSummary": {
          "documentType": "模型报告",
          "rankBucket": "前25%",
          "innovation": "1.5",
          "technicalRigor": "1.2",
          "experimentalSufficiency": "1.0",
          "clarity": "0.8",
          "impact": "1.3",
          "openSource": "1.0",
          "reproducibility": "0.3",
          "engineeringScore": "1.2",
          "confidence": "高",
          "primaryTaskTag": "#语音合成",
          "primaryMethodTag": "#扩散模型",
          "sotaClaim": "否",
          "hasCode": "是",
          "hasModel": "是",
          "hasDataset": "否"
        },
        "rankBucket": "前25%",
        "innovationScore": "1.5",
        "technicalRigorScore": "1.2",
        "experimentalSufficiencyScore": "1.0",
        "clarityScore": "0.8",
        "impactScore": "1.3",
        "openSourceScore": "1.0",
        "reproducibilityScore": "0.3",
        "engineeringScore": "1.2",
        "confidence": "高",
        "primaryTaskTag": "#语音合成",
        "primaryMethodTag": "#扩散模型",
        "sotaClaim": "否",
        "hasCode": "是",
        "hasModel": "是",
        "hasDataset": "否"
      },
      "selectedImageUrls": ["https://arxiv.org/html/.../fig1.png"],
      "imageUrls": ["https://arxiv.org/html/.../fig1.png"],
      "allImageUrls": ["https://arxiv.org/html/.../fig1.png", "..."],
      "analysisSource": "html",
      "sourceTextChars": 82431,
      "usedTextChars": 82431,
      "fullTextChars": 82431,
      "fullTextAvailable": true,
      "truncated": false,
      "sourceSha256": "<64位十六进制>",
      "analysisConfidence": "full_text",
      "sourceWarnings": [],
      "imageManifest": {
        "totalFound": 8,
        "candidateLimit": 20,
        "downloaded": [
          {"url": "https://arxiv.org/html/.../fig1.png", "mime": "image/png", "base64Chars": 120000, "sha256": "<64位十六进制>", "cacheHit": false}
        ],
        "downloadOutcomes": [{"url": "...", "status": "downloaded", "cacheHit": false}],
        "selected": ["https://arxiv.org/html/.../fig1.png"]
      },
      "analysisManifest": {
        "version": 1,
        "sourceAcquisition": {"analysisSource": "html", "sourceSha256": "<64位十六进制>"},
        "stages": {
          "imageDownload": {"status": "complete"},
          "primaryAnalysis": {"status": "complete"},
          "openSourceScan": {"status": "complete"},
          "demoLinkScan": {"status": "complete"},
          "revision": {"status": "complete"},
          "tableRepair": {"status": "not_needed"},
          "methodRepair": {"status": "complete"},
          "structureRepair": {"status": "not_needed"},
          "scoringAudit": {"status": "complete"},
          "imageSupplement": {"status": "complete"}
        }
      }
    }
  ]
}
```

`reanalyzed` / `reanalyzeFailed` 记录最近全量重分析及后续失败恢复后的累计状态。`reanalyze-selected.js` 另写本次指定重跑统计，并只对从旧评分契约恢复到当前契约的论文校正累计成功/失败数，避免重复重跑造成计数膨胀。

**关于 `parsed` 字段的说明**：

- `parsed` 是 `analysis` 文本的解析缓存，由 `scripts/utils.js` 的 `parseAnalysis()` 或 `scripts/utils.py` 的 `parse_analysis()` 生成
- `documentType` 来自机器摘要的 `document_type`，受控值为方法研究、系统技术报告、模型报告、数据集与基准、综述、理论研究、应用研究；常见中英文别名会归一化，未知类型会被拒绝
- 只有包含合法 `document_type` 的新分析才写入 `scoringRubricVersion: type-aware-v1`；历史结果不补写版本，以免误标
- `analysisSource` 为 `html` / `pdf` / `provided_full_text` / `provided_pdf_text` / `abstract`；`sourceTextChars` 记录取得的原文长度，`usedTextChars` 记录主分析实际输入长度。超长来源会按全文位置和任务关键词确定性取样，因此 `usedTextChars` 不等同于简单前缀截断。字符数、截断状态、来源哈希和告警用于识别摘要降级及 checkpoint 证据变化。`abstract` 默认阻断发布，人工批准需设置 `allowAbstractAnalysisPublish: true`
- `selectedImageUrls` / `imageUrls` 只保存通过稳定 `paragraph_id`、目标章节匹配和每篇默认 4 张上限门禁后实际插入正文的高价值图片，并按最终正文出现顺序保存；旧精确 anchor 仅用于兼容。`allImageUrls` 不能直接当作可发布图片使用
- `generation` 每次锁内对象写入递增。恢复终态还包括 `no_downloadable_images`：候选均为永久不可下载；`invalid_output` 表示有插图计划但无法落地，必须只重试插图阶段
- `analysisManifest.stages.scoringAudit` 保存模型、温度、prompt 模板哈希、证据哈希、尝试次数、前后总分/差值、稳定性告警和最终八维 JSON；分数变化超过 0.5 会写 `stabilityWarning: true`。`imageManifest.supplement` 保存副模型、温度、prompt/响应哈希及逐项插入诊断
- `analysisStageCheckpoints` 保存逐阶段快照；指纹绑定主分析实际取样输入、`task-focused-v1` 证据选择版本、各阶段字符预算、模型/协议/端点、温度、实际 prompt、图片候选与下载 SHA。预算或输入变化只回滚受影响阶段及下游，续跑从首个未完成阶段开始
- 失败结果保留恢复 checkpoint；若旧成功正文仍可用，`latestAnalysisAttemptError` 与 `digestStatus.latestAttemptStatus=analysis_failed` 会明确标记最新失败，下一轮继续重试而不会把旧正文误当成最新成功。成功重试会清理这些标记。每篇内容只能在共享论文锁内从最新规范记录合并写回，批次收尾不得用旧累计快照覆盖并发进程的新结果
- **`parsed.score` 不是直接取 `## 评分` 下的 LLM 原始总分**。只有八个分项完整、唯一、各自带具体理由、分母正确、数值有限且位于合法范围时才重新计算并封顶为 10；否则 `scoreValidation` 记录契约错误并阻断保存/发布，不会把缺失维度当 0 覆盖原分数
- `parsed` 中的 `machineSummary` 是 `## 机器摘要` 的解析结果；`rankBucket`、`innovationScore`、`technicalRigorScore` 等 8 个子项字段同时平铺到 `parsed` 顶层以便访问
- `npm run validate:data` 会从 `analysis` 重解析完整正文，校验全部必需恢复阶段已进入终态，并逐字段核对 `parsed` 缓存、文档类型、rubric 版本、八个子项范围以及 `parsed.score == min(八项之和, 10)`；只有字段集合精确匹配且来源、原因完整的 `parsedOverride.type=manual` 可以解释缓存差异，最新失败标记仍存在时校验失败
- 发布前会从 `analysis` 重新解析并与 `parsed`、顶层评分版本比较；缓存不一致会阻断发布。人工覆盖必须通过 `parsedOverride` 明确声明类型、来源、原因和允许覆盖字段，并仍满足最多一位小数及开源固定锚点契约

### 5.7 `data/current/visual-summary-manifests/YYYY-MM-DD.json`

该 manifest 只在全部博客远端发布验证成功后建立，论文集合为最终评分 TOP 10；同分按规范化 arXiv ID 稳定排序。它不是博客发布输入；旧版 v1/v2 清单会迁移为 v3 TOP 10 单长图任务。

```json
{
  "version": 3,
  "batchDate": "2026-07-13",
  "selection": {"type": "top_score", "limit": 10, "sourcePaperCount": 14},
  "promptSha256": "<64位十六进制>",
  "updatedAt": "2026-07-13T18:00:00.000+08:00",
  "papers": {
    "2607.12345": {
      "arxivId": "2607.12345v1",
      "normalizedArxivId": "2607.12345",
      "title": "Paper title",
      "batchDate": "2026-07-13",
      "rank": 1,
      "score": 9.1,
      "analysisSha256": "<64位十六进制>",
      "promptSha256": "<64位十六进制>",
      "generationContext": {
        "title": "Paper title",
        "documentType": "方法研究",
        "primaryTask": "语音识别",
        "primaryMethod": "自监督学习",
        "summary": "...",
        "method": "...",
        "experiments": "...",
        "limitations": "...",
        "qaClaims": {
          "exactEnglishTitle": "Paper title",
          "bodyLanguage": "简体中文",
          "requiredSections": ["研究问题", "方法与结构", "实验与数字", "结论与局限"],
          "methodClaims": ["..."],
          "metricClaims": ["..."],
          "limitationClaims": ["..."],
          "referenceCaptions": ["Figure 1: Method overview."]
        },
        "referenceImages": [{
          "role": "method_reference",
          "url": "https://arxiv.org/html/2607.12345v1/figure/method.png",
          "caption": "Figure 1: Method overview.",
          "mime": "image/png",
          "bytes": 123456,
          "sha256": "<64位十六进制>",
          "cachePath": "data/current/image-cache/<URL-SHA>.bin"
        }],
        "rendering": {"mode": "full_image_generation_v2", "renderer": "built-in image_gen", "resolutionPolicy": "highest_available_portrait", "orientation": "portrait", "preferredAspectRatio": "1:2", "minimumWidth": 768, "minimumHeight": 1024, "maxPngBytes": 8388608}
      },
      "cards": {
        "infographic": {
          "status": "complete",
          "label": "论文长图摘要",
          "taskToken": "<64位十六进制>",
          "assetPath": "data/archive/2026-07-13/visual-summaries/01-2607.12345-example-paper-title.png",
          "assetSha256": "<64位十六进制>",
          "analysisSha256": "<64位十六进制>",
          "promptSha256": "<64位十六进制>",
          "completedAt": "2026-07-13T18:00:00.000+08:00"
        }
      }
    }
  }
}
```

- `papers` 必须与目标批次最终评分 TOP 10 精确一致；不足十篇时包含全部成功论文。
- 每篇 `cards` 必须恰好包含 `infographic`；只有它为 `complete` 且通过资产验证才算该论文视觉摘要完成。
- `qaClaims` 是登记前逐图事实核对清单：标题必须逐字一致，正文必须为简体中文，四个必要内容区均需覆盖，方法、数字、局限和参考图说明不得被自由改写成相反含义。
- `referenceImages` 最多两张，只接纳深度分析已选中且本地缓存 URL、MIME、字节数和 SHA 全部匹配的论文原图；方法总览、架构、框架和流程图优先于实验图。参考图摘要进入分析/任务指纹，原图缺失、损坏或变化时只使对应论文长图失效。`cachePath` 指向只读语义的 `.bin` 原始缓存，不能直接传给内置生图；运行 `visual:prepare` 后使用输出的绝对 `referencedImagePaths`，`relativePath` 仅供日志展示。对应文件位于 `data/current/visual-reference-inputs/<日期>/<排名-论文>/` 且具有经 MIME/文件头共同确认的 `.png/.jpg/.webp` 扩展名。
- 完成项同时绑定最终 `rank`、当前分析 SHA、`prompts/visual-summary.md` SHA、task token 和 PNG 资产 SHA。归档目录使用两位 rank 前缀，保证文件系统排序与排行榜一致；分析、prompt、参考图、排名或资产变化后只使对应论文长图失效并回到待生成。
- 任意 `pending` / `failed`、资产缺失/损坏或 SHA 不匹配只影响发布后视觉阶段，不影响已经完成的博客发布。
- PNG 必须不超过 8 MiB，至少 768×1024 且高宽比不低于 1.25；顶部使用完整英文标题，图内使用约 220–360 个中文字符完整说明问题、方法、实验、结论与局限。参考图用于保留真实结构关系并统一风格重绘，不得直接贴入不可读截图。PNG 由 Codex 内置图像生成能力产生；项目脚本只管理状态和资产，不调用图像 API。

### 5.8 `data/current/digest-cover-manifests/YYYY-MM-DD.json`

全部博客发布后，每个批次生成一张汇总图。上下文只从同批次通过完整契约且最新尝试未失败的论文确定性计算；热门方向按主任务标签计数排序，排行榜按分数降序取 TOP 10（不足十篇时全部纳入；同分用规范化 ID 稳定排序）。

```json
{
  "version": 1,
  "batchDate": "2026-07-13",
  "dataSha256": "<64位十六进制>",
  "promptSha256": "<64位十六进制>",
  "generationContext": {
    "title": "语音/音乐/音频论文速递 2026-07-13",
    "batchDate": "2026-07-13",
    "paperCount": 14,
    "hotDirections": [{"tag": "#语音识别", "count": 4}],
    "ranking": [{"rank": 1, "arxivId": "2607.12345", "title": "Paper title", "score": "9.1", "primaryTask": "#语音识别"}],
    "rankingCount": 1,
    "rankingLimit": 10,
    "rendering": {"mode": "full_image_generation_v2", "renderer": "built-in image_gen", "resolutionPolicy": "highest_available_portrait", "orientation": "portrait", "preferredAspectRatio": "1:2", "minimumWidth": 768, "minimumHeight": 1024, "maxPngBytes": 8388608}
  },
  "cover": {
    "status": "complete",
    "label": "汇总页封面",
    "taskToken": "<64位十六进制>",
    "assetPath": "data/archive/2026-07-13/visual-summaries/00-digest-cover-2026-07-13.png",
    "assetSha256": "<64位十六进制>"
  },
  "overallStatus": "complete"
}
```

- `dataSha256` 绑定标题、论文数量、热门方向及排名上下文，`promptSha256` 绑定 `prompts/digest-cover.md`；任一变化只使封面失效，不影响论文长图。
- 会议流程的 category 自动取自 generation manifest；它会改变标题并进入 `dataSha256`，避免会议汇总图与博客标题不一致，无需给 status 另传参数。
- manifest 可保存 `arxivId` 以稳定指纹和排序，但 prompt 明确禁止把论文 ID 渲染到封面；排名展示完整英文标题、分数和主方向。
- 论文长图和汇总封面生成后直接进入 `data/archive/<日期>/visual-summaries/`；旧版 current 资产仅在 PNG/SHA 校验通过且归档目标无冲突时迁移。历史批次中不属于最终 TOP10 的旧卡片在同一目录平铺命名为 `unranked-<paper-id>-<kind>.png`，并写入视觉 manifest 的 `legacyUnrankedAssets` 路径/SHA 账本，避免虚构排行榜编号或留下未登记文件。两类图片共享最小尺寸、纵横比、大小和 SHA 门禁，实际生成像素不写死；缺失、失败、损坏、过期或存在重复/未登记 PNG 时状态门禁失败，但不回滚博客发布。

### 5.8.1 `data/current/digest-run-reports/YYYY-MM-DD.json`

`npm run digest:status -- --date YYYY-MM-DD` 生成的统一只读验收快照。它汇总候选抓取、筛选决定覆盖、成功深度分析、博客严格 review 与远端 OID、论文长图和汇总封面的完成数量及错误列表。只有全部必需阶段均为 `complete` 时顶层 `overallStatus` 才为 `complete` 且命令返回 0；报告不替代各阶段原始 manifest 或凭证。

### 5.9 `data/current/analyzed.json`

旧版已分析记录（`fetch-papers.js` 直跑流程遗留）。当前主流程不直接使用，但保留兼容，参与每日归档。

---

### 5.10 博客阶段 journal、清单与审查凭证

- generation staging/install journal：逐页记录输入指纹、安装前 SHA 和目标 SHA；崩溃后只收养内容完全匹配的页面，全部论文完成后才生成汇总页和严格 manifest。
- `blog-generation-manifest-YYYY-MM-DD.json`：正式清单为 schema v3，记录非空、唯一且结构合法的精确 Markdown 文件集合、输入/生成依赖指纹、博客基线、category、逐文件 SHA，以及经过发布预检后实际写入博客的 `publishedPapers` 权威快照；`visualSummaryRequired` 与 `digestCoverRequired` 必须为 `false`，发布后图片不得进入清单。
- `blog-review-passes-YYYY-MM-DD.json`：持久保存已通过页面的博客仓库相对路径、实际读取 SHA-256、通过时间和当时的 review 协议指纹。复用只依赖路径 + SHA；代码、脚本、文档、模型、协议、generation manifest 或博客基线变化不会删除记录，页面内容变化时只让该页面重新进入 review。
- `blog-review-failure-YYYY-MM-DD.json`：schema v3 绑定 worker 实际读取 SHA，并保留当次生成清单、博客基线和协议元数据供审计；这些批次元数据变化不再让未改的已通过页面全量复审。内容失败修复后只复审失败页，瞬时失败保持可重试；应存在文件消失或 Hugo 前后 SHA 变化均阻断签发整批凭证。
- `blog-review-receipt-YYYY-MM-DD.json`：review 阶段记录文件 SHA 和各文件实际通过时的协议指纹，并重新绑定当前 generation manifest 的 SHA-256、当前 review 协议和 Hugo gate；push 远端 OID 验证成功后追加 `publicationCommit`、相同的 `remoteVerifiedOid` 和北京时间 `remoteVerifiedAt`。发布后视觉规划从 generation 的 `publishedPapers` 读取实际发布集合，并把发布提交与 generation SHA 写入任务 token。

三个博客入口同时用日期级锁和博客仓库级全局锁串行化；push 在 stage 后及 commit 前校验 index blob 与凭证完全一致。

### 5.11 `data/current/xiaohongshu-oneliners-YYYY-MM-DD.json`

仅用于生成小红书文案的逐篇成功缓存。每条绑定分析、prompt、模型端点配置与清洗契约指纹；日期级锁内原子写入。损坏缓存会隔离改名后重建，失败回退或指纹变化只重跑对应论文，不会触发自动发布。

默认数据源生成文案时，若同日 `blog-generation-manifest-YYYY-MM-DD.json` 存在，小红书脚本先验证 review receipt 已绑定清单 SHA、严格 review、发布提交与相同远端 OID，再以 schema v3 `publishedPapers` 为权威集合，并在发布预检前排除未进入博客的分析记录。这样博客明确排除项不会导致后续文案全批次失败，同时未审查或未完成远端验证的清单不能冒充已发布集合；自定义数据文件不受该绑定影响。
