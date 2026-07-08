# Data File Formats

## Data File Format Reference

### 5.1 `data/current/papers.json`

Paper deduplication database. **This file is not archived; it accumulates continuously.** Structure:

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
        "error": null
      }
    }
  },
  "lastUpdated": "2026-04-21T10:00:00+08:00"
}
```

`pending_analysis` and `analysis_failed` are not used for strong deduplication in the next `full-fetch`, so interrupted or failed analyses can naturally re-enter the pipeline. Successful analysis updates the status to `analyzed`. `full-fetch.js`, `deep-analysis-only.js`, `reanalyze.js`, `batch-analyze.js`, `reanalyze-selected.js`, and `analyze-single-paper.js` all sync this status through `scripts/digest-status.js` to avoid divergent write paths.

### 5.2 `data/current/raw-candidates.json`

Candidate input after arXiv + HuggingFace merge and blog-published filtering. Used to debug why a paper did or did not enter filtering.

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

When `papers` is empty and `sourceHealth` contains failures, the main workflow only treats a complete core arXiv failure or a failure of the only attempted source as fatal; individual category failures or HuggingFace supplementary-source failures are recorded but do not necessarily block a legitimate empty candidate batch.

### 5.3 `data/current/filter-decisions.json`

Per-paper LLM filtering decision cache. It is written after every batch; reruns only reuse it when `filterModel` and `filterPromptHash` match the current configuration.

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
      "title": "Paper Title",
      "related": true,
      "reason": "The paper contains a speech recognition task and audio experiments",
      "rawResponse": "Reason: speech recognition task...\nConclusion: related",
      "parseSource": "conclusion_line",
      "decidedAt": "2026-04-21T10:05:00+08:00",
      "filterModel": "mimo-v2.5",
      "filterPromptHash": "a1b2c3d4e5f6a7b8"
    }
  }
}
```

### 5.4 `data/current/filtered-papers.json`

Filtering results (metadata only, no deep analysis). Structure:

```json
{
  "timestamp": "2026-04-21T10:00:00+08:00",
  "status": "complete",
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

### 5.5 `data/current/deep-analysis-result.json`

Core analysis results. Structure:

```json
{
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
    "both": 3
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
      "parsed": {
        "score": "8.5",
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
      }
    }
  ]
}
```

**Notes on the `parsed` field**:

- `parsed` is a parsed cache of the `analysis` text, generated by `parseAnalysis()` in `scripts/utils.js` or `parse_analysis()` in `scripts/utils.py`
- `selectedImageUrls` / `imageUrls` are the high-value figures confirmed by the secondary model for in-text insertion; `allImageUrls` is only the raw candidate list and must not be treated as publishable figures by default
- **`parsed.score` is not the raw total score from the LLM under `## 评分`**. Instead, it is recalculated by extracting eight sub-items from `## 评分理由` (Innovation/2, Technical Rigor/1.5, Experimental Sufficiency/1.5, Clarity/1, Impact/1.5, Open Source/1.5, Reproducibility/0.5, Engineering/Practical Value/1.5), capping at 10, rounding to 0.1, and overriding the LLM's raw output
- `machineSummary` inside `parsed` is the parsed result of `## 机器摘要`; fields such as `rankBucket`, `innovationScore`, `technicalRigorScore`, etc. are also flattened to the top level of `parsed` for easier access
- When parsing logic changes, the `parsed` cache is cleared and regenerated on the next publish

### 5.6 `data/current/analyzed.json`

Legacy analyzed records (leftover from the `fetch-papers.js` direct-run workflow). Not directly used by the current main workflow, but kept for compatibility and included in daily archiving.

---
