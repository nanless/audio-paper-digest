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

### 5.2 `data/current/raw-candidates.json`

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

### 5.3 `data/current/filter-decisions.json`

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

### 5.4 `data/current/filtered-papers.json`

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

### 5.5 `data/current/deep-analysis-result.json`

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
      "imageManifest": {
        "totalFound": 8,
        "candidateLimit": 20,
        "downloaded": [
          {"url": "https://arxiv.org/html/.../fig1.png", "mime": "image/png", "base64Chars": 120000}
        ],
        "selected": ["https://arxiv.org/html/.../fig1.png"]
      },
      "analysisManifest": {
        "version": 1,
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
- `selectedImageUrls` / `imageUrls` 是副模型确认插入正文的高价值图片，并按最终正文出现顺序保存；无真实 caption 的通用 `图N` alt 也按该顺序归一化。`allImageUrls` 是原始候选图片列表，不能直接当作可发布图片使用
- `generation` 每次锁内对象写入递增，用于检测和合并并发更新。`analysisManifest` 版本 1 的所有必需阶段必须处于 `complete` / `not_needed` / `skipped` / `no_candidates` / `no_high_value_images` 才算成功；严格空插图计划才会产生 `no_high_value_images`
- 失败结果可暂存 `analysisCheckpoint` 与 `analysisRecoveryImageManifest` 供续跑；若旧成功正文仍有效，`analysis` / `parsed` 保持不变，恢复字段和 `digestStatus.latestAttemptStatus: analysis_failed` 叠加保存。下一次成功后恢复 checkpoint 字段会被删除
- **`parsed.score` 不是直接取 `## 评分` 下的 LLM 原始总分**。只有八个分项完整、唯一、分母正确、数值有限且位于合法范围时才重新计算并封顶为 10；否则 `scoreValidation` 记录契约错误并阻断保存/发布，不会把缺失维度当 0 覆盖原分数
- `parsed` 中的 `machineSummary` 是 `## 机器摘要` 的解析结果；`rankBucket`、`innovationScore`、`technicalRigorScore` 等 8 个子项字段同时平铺到 `parsed` 顶层以便访问
- `npm run validate:data` 会校验文档类型、rubric 版本、八个子项范围以及 `parsed.score == min(八项之和, 10)`
- 发布前会从 `analysis` 重新解析并与 `parsed`、顶层评分版本比较；缓存不一致会阻断发布。人工覆盖必须通过 `parsedOverride` 明确声明类型、来源、原因和允许覆盖字段，并仍满足最多一位小数及开源固定锚点契约

### 5.6 `data/current/analyzed.json`

旧版已分析记录（`fetch-papers.js` 直跑流程遗留）。当前主流程不直接使用，但保留兼容，参与每日归档。

---
