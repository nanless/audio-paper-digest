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
        "latestAttemptStatus": "analyzed | analysis_failed",
        "error": null
      }
    }
  },
  "lastUpdated": "2026-04-21T10:00:00+08:00"
}
```

When both are present, top-level `status` and `stats.analysisStatus` must match. Allowed values are `running`, `complete`, `partial_failed`, and `failed` (historical refiltering may also use `filter_failed`). `deepAnalysisCompletedAt` is valid only for `complete` and must be a Beijing ISO timestamp. Resume status is recomputed from all canonical successful papers, not only successes added in the current attempt.

`pending_analysis` and `analysis_failed` are not used for strong deduplication in the next `full-fetch`, so interrupted or failed analyses can naturally re-enter the pipeline. Successful analysis updates the status to `analyzed`. `full-fetch.js`, `deep-analysis-only.js`, `reanalyze.js`, `batch-analyze.js`, `reanalyze-selected.js`, `analyze-single-paper.js`, and `refilter-reanalyze-by-date.js` all sync this status through `scripts/digest-status.js` to avoid divergent write paths. If the latest attempt fails but an older successful analysis is still available, `status` remains `analyzed`, while `latestAttemptStatus: "analysis_failed"` and `error` record the failed attempt; failure writes do not overwrite existing successful `analysis` / `parsed` / image metadata with empty values.

### 5.2 `data/current/fetch-checkpoint.json`

Per-source crawl checkpoint. Each arXiv category and HuggingFace store status, paper array, `papersCount`, stable `papersSha256`, and health; tampering invalidates only that source. Fixed category order, immutable historical baseline, fingerprints, and Beijing batch date must match raw/decision/filtered artifacts. Filtering requires complete valid coverage.

### 5.3 `data/current/raw-candidates.json`

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

Fetchers record attempts, successful requests, and failure details in `sourceHealth`. A source whose every request failed is fatal and cannot be represented as a successful empty batch; an actual successful empty response remains valid. Partial supplementary-source failures remain diagnostic when another request succeeded.

`npm run validate:data` checks the `papers` array, the basic `sourceHealth` shape, and candidate stats: `stats.afterBlogSkip` must equal the candidate paper count, `stats.skippedFromBlog` must equal the before/after blog-deduplication difference, and `stats.arxivOnly + stats.hfOnly + stats.both` must equal the pre-blog-deduplication candidate total.

### 5.4 `data/current/filter-decisions.json`

Per-paper LLM filtering decision cache. It is written after every batch; reruns only reuse definitive boolean decisions from the same `filterModel` and `filterPromptHash`. API failures and indeterminate outputs are stored separately as retryable diagnostics and prevent `stats.complete=true`.
`npm run validate:data` checks that `stats.decided` equals the number of `decisions`, `stats.related` equals the number of decisions with `related: true`, each decision has a boolean `related`, and fields such as `reason` / `rawResponse` / `parseSource` are strings when present. When `stats.complete=true`, `decisions` must cover every candidate in `raw-candidates.json`.

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

### 5.5 `data/current/filtered-papers.json`

Filtering results (metadata only, no deep analysis). Structure:
New-format allowed `status` values are `filtering`, `filter_complete`, and `complete`, and the file must include `filterModel` and `filterPromptHash`. `filter_complete` is a transient state after per-paper LLM filtering but before archive deduplication. Only `complete` with a model/hash matching the current configuration lets the main workflow skip crawling/filtering and resume deep analysis on same-day reruns. Older object-format files without `status` do not trigger the skip-crawl/filter resume path, and `npm run validate:data` reports them so they can be regenerated or migrated.

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

For `complete` output:
- `filterModel` and `filterPromptHash` must exist so same-day filtered output can be safely matched against the current configuration before reuse
- `filterModel` / `filterPromptHash` must match the root fields in `filter-decisions.json`
- `stats.afterBlogSkip` must equal `filter-decisions.json.stats.totalCandidates`
- `stats.decisionCount` must equal the number of entries in `filter-decisions.json.decisions`
- `stats.afterFilter` must equal the number of `filter-decisions.json` entries with `related: true`
- `stats.afterArchiveSkip` must equal final `papers.length`
- When `stats.afterBlogSkip` is larger than final `papers.length`, the same-batch `raw-candidates.json` must be retained so the full filtering input can be audited

`npm run validate:data` checks these constraints read-only so corrupted filter caches are not silently reused by resumed runs.

### 5.6 `data/current/deep-analysis-result.json`

Core analysis results. Structure:

```json
{
  "generation": 12,
  "timestamp": "2026-04-21T10:00:00+08:00",
  "previousTimestamp": "2026-04-20T10:00:00+08:00",
  "status": "complete",
  "deepAnalysisCompletedAt": "2026-04-21T12:30:00+08:00",
  "stats": {
    "analysisStatus": "complete",
    "remainingFailed": 0,
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
        "contracts": {"experimentTables": "evidence-rich-v2"},
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

`reanalyzed` / `reanalyzeFailed` describe cumulative full-reanalysis status after subsequent failure recovery. `reanalyze-selected.js` also writes per-run selected-reanalysis stats and reconciles cumulative counts only when a paper moves from an older scoring contract to the current one, preventing repeated reruns from inflating recovery counts.

**Notes on the `parsed` field**:

- `parsed` is a parsed cache of the `analysis` text, generated by `parseAnalysis()` in `scripts/utils.js` or `parse_analysis()` in `scripts/utils.py`
- `documentType` comes from machine-summary `document_type` and is controlled to 方法研究, 系统技术报告, 模型报告, 数据集与基准, 综述, 理论研究, or 应用研究. Common Chinese/English aliases are normalized and unknown values are rejected
- `scoringRubricVersion: type-aware-v1` is written only for new analyses containing a valid `document_type`; historical results are not mislabeled
- `analysisSource`, source lengths, truncation, SHA-256, confidence, and warnings distinguish HTML/PDF/full-text input from abstract fallback. `sourceTextChars` is the acquired source length and `usedTextChars` is the actual primary-analysis input; very long sources use deterministic cross-document, task-aware sampling rather than prefix-only truncation. Abstract-only results require explicit `allowAbstractAnalysisPublish: true` approval before publishing
- `analysisManifest.stages.scoringAudit` retains model/options, prompt/evidence hashes, attempts, previous/final score and delta, the final audit JSON, and `stabilityWarning` when absolute drift exceeds 0.5
- New analyses and reanalyses write `analysisManifest.contracts.experimentTables=evidence-rich-v2` after structure repair. Besides the existing upper bounds, the marker requires an identifier field, three evidence rows, two numeric cells, metric directions, a specific pre-table comparison question, and a post-table synthesis with its evidence boundary; source-provided ablations or negative results must be represented. Manual v5 binds `editorialQuality=reader-facing-v1`; `manualTakeover.researchBrief.editorialPlan` v2 stores reader-first title/thesis and anchors, while the SHA-bound `manualTakeover.readerArticle` is the publication body and source-closed `resultClaims` carry reader-visible narratives in both canonical results and that article. When that hash is valid, publication renders Chinese title, English title/arXiv link, tags/score, a two-sided evidence-bound snarky review from `editorial.review`, core summary, the reader article, open resources, and final score evidence in that order. `npm run validate:data` and Python publication preflight enforce matching semantics. Historical contracts retain their original compatibility behavior
- `selectedImageUrls` / `imageUrls` contain only high-value figures inserted through a stable `paragraph_id`, target-section, and four-image-limit gate, stored in final body order. Legacy exact anchors remain compatible. `imageManifest` also preserves per-URL outcomes, cache hits, model/options, hashes, and insertion diagnostics
- Root `generation` increments after a writer acquires the cross-process lock, re-reads canonical state, and merges its update. It is a committed-version record, not caller-supplied expected-generation optimistic CAS. Every mandatory version-1 `analysisManifest` stage must be terminal (`complete`, `not_needed`, `skipped`, `no_candidates`, or `no_high_value_images`) before the paper is successful; only a strict empty insertion plan produces `no_high_value_images`
- `analysisStageCheckpoints` persists stage snapshots. Fingerprints cover the actual sampled primary input, the `task-focused-v1` evidence-selector version, per-stage character budgets, model/protocol/endpoint, temperatures, extracted prompts, image candidates, and downloaded hashes; a budget or input change invalidates only the affected stage and downstream work
- Failed records retain recovery checkpoints. If an older successful body remains usable, `latestAnalysisAttemptError` and `digestStatus.latestAttemptStatus=analysis_failed` still mark the latest attempt as failed so the next run retries it; a successful retry clears those markers. Every paper payload is merged from the latest canonical record under the shared paper lock, and batch finalization must not rewrite stale cumulative paper payloads
- **`parsed.score` is not the raw total score from the LLM under `## 评分`**. It is recomputed only when all eight dimensions are complete and unique, each includes a concrete reason, denominators are correct, and values are finite and in range. Otherwise `scoreValidation` records a contract error and saving/publishing is blocked rather than treating missing dimensions as zero
- `machineSummary` inside `parsed` is the parsed result of `## 机器摘要`; fields such as `rankBucket`, `innovationScore`, `technicalRigorScore`, etc. are also flattened to the top level of `parsed` for easier access
- `npm run validate:data` reparses the complete `analysis` body, requires all mandatory recovery stages to be terminal, and compares the derived fields with cached `parsed` values before checking document type, rubric version, dimension ranges, and `parsed.score == min(sum of eight dimensions, 10)`. Only a `parsedOverride.type=manual` with complete provenance and an exact field-set match may explain cache differences. A remaining latest-attempt failure marker is an error
- Before publishing, `analysis` is reparsed and compared with cached `parsed` data and the top-level rubric version. Mismatches block publishing; manual overrides require explicit type, source, reason, and allowed fields in `parsedOverride` and still must satisfy one-decimal values and fixed Open Source anchors

### 5.7 `data/current/visual-summary-manifests/YYYY-MM-DD.json`

This manifest is created only after every blog page is remotely verified as published. Its paper set is the final-score TOP 10 with normalized-arXiv-ID tie breaking, and it is not a blog-publication input. Legacy v1/v2 manifests migrate to the v3 TOP 10 contract.

```json
{
  "version": 3,
  "batchDate": "2026-07-13",
  "selection": {"type": "top_score", "limit": 10, "sourcePaperCount": 14},
  "promptSha256": "<64 lowercase hex characters>",
  "updatedAt": "2026-07-13T18:00:00.000+08:00",
  "papers": {
    "2607.12345": {
      "arxivId": "2607.12345v1",
      "normalizedArxivId": "2607.12345",
      "title": "Paper title",
      "batchDate": "2026-07-13",
      "rank": 1,
      "score": 9.1,
      "analysisSha256": "<64 lowercase hex characters>",
      "promptSha256": "<64 lowercase hex characters>",
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
          "sha256": "<64 lowercase hex characters>",
          "cachePath": "data/current/image-cache/<URL-SHA>.bin"
        }],
        "rendering": {"mode": "full_image_generation_v2", "renderer": "built-in image_gen", "resolutionPolicy": "highest_available_portrait", "orientation": "portrait", "preferredAspectRatio": "1:2", "minimumWidth": 768, "minimumHeight": 1024, "maxPngBytes": 8388608}
      },
      "cards": {
        "infographic": {
          "status": "complete",
          "label": "Paper infographic",
          "taskToken": "<64 lowercase hex characters>",
          "assetPath": "data/archive/2026-07-13/visual-summaries/01-2607.12345-example-paper-title.png",
          "assetSha256": "<64 lowercase hex characters>",
          "analysisSha256": "<64 lowercase hex characters>",
          "promptSha256": "<64 lowercase hex characters>",
          "completedAt": "2026-07-13T18:00:00.000+08:00"
        }
      }
    }
  }
}
```

- `papers` must exactly match the target batch's final-score TOP 10, or all successful papers when fewer than ten exist.
- Each `cards` object must contain exactly `infographic`; it completes only after the asset passes validation.
- `qaClaims` is the itemized pre-record fact checklist: the title must match exactly, the body must be Simplified Chinese, all four content regions must be present, and method, numeric, limitation, and reference-caption claims must preserve their source meaning.
- `referenceImages` contains at most two figures that deep analysis selected and whose cached URL, MIME, byte count, and SHA all match. Method overviews, architectures, frameworks, and pipelines outrank experiment figures. Their verified summaries enter the analysis/task fingerprint, so a missing, damaged, or changed source invalidates only that paper's infographic. `cachePath` is the read-only `.bin` source cache and must not be uploaded directly. Run `visual:prepare` and use its absolute `referencedImagePaths`; `relativePath` is display-only. The files live under `data/current/visual-reference-inputs/<date>/<rank-paper>/` with `.png/.jpg/.webp` extensions jointly verified from MIME and magic bytes.
- A completed infographic binds final `rank`, the current analysis SHA, `prompts/visual-summary.md` SHA, task token, and PNG asset SHA. Its two-digit rank prefix keeps filesystem order identical to leaderboard order; analysis, prompt, reference-figure, rank, or asset changes invalidate only that paper's infographic.
- Pending/failed or damaged assets affect only the post-publication visual stage and never roll back the completed blog publication.
- PNGs are at most 8 MiB, at least 768×1024, and have a height/width ratio of at least 1.25. The complete English title is at the top, while roughly 220–360 Chinese characters substantively explain the problem, method, experiments, conclusion, and limitations. References preserve real structural relationships for a unified redraw; unreadable screenshots must not be pasted into the poster. Codex built-in image generation creates the PNGs; project scripts never call an image API.

### 5.8 `data/current/digest-cover-manifests/YYYY-MM-DD.json`

After all blogs publish, every batch produces one digest image. Its context is deterministically derived only from contract-valid papers in the target batch whose latest attempt did not fail.

```json
{
  "version": 1,
  "batchDate": "2026-07-13",
  "dataSha256": "<64 lowercase hex characters>",
  "promptSha256": "<64 lowercase hex characters>",
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
    "label": "Digest cover",
    "taskToken": "<64 lowercase hex characters>",
    "assetPath": "data/archive/2026-07-13/visual-summaries/00-digest-cover-2026-07-13.png",
    "assetSha256": "<64 lowercase hex characters>"
  },
  "overallStatus": "complete"
}
```

- `dataSha256` binds title, paper count, hot directions, and ranking; `promptSha256` binds `prompts/digest-cover.md`. Either change invalidates only the cover.
- Conference category is read automatically from the generation manifest. It changes the title and therefore `dataSha256`, preventing a digest-image/blog-title mismatch without a separate status argument.
- The manifest keeps `arxivId` for stable sorting and fingerprinting, but the prompt forbids rendering paper IDs. Ranking entries display the complete English title, score, and primary direction.
- Paper infographics and the digest cover are archived flat under `data/archive/<date>/visual-summaries/`; legacy current assets migrate only after PNG/SHA verification and conflict checks. Newly recorded assets include a `qaAttestation` with checklist version and Beijing timestamp. The CLI accepts `record` only with `--qa-attested true`, proving that title, body, diagram relations, numeric claims, and ranking semantics were visually checked.

### 5.8.1 `data/current/digest-run-reports/YYYY-MM-DD.json`

The unified read-only completion snapshot written by `npm run digest:status -- --date YYYY-MM-DD`. It summarizes candidate fetch, filtering-decision coverage, successful deep analyses, strict blog review and remote OID verification, paper infographics, the digest cover, and their error lists. The terminal prints only compact stage counts and errors, while full diagnostics such as `fetch.sourceHealth` remain in JSON. `visuals.gateComplete` is the final infographic gate combining status, counts, canonical asset validation, archive uniqueness, and publication binding, so the terminal never infers completion from counts alone. `overallStatus` is `complete` and the command exits zero only when every required stage is complete. The report reflects state read during that invocation; later push/record operations do not update it, so rerun the command before treating it as current. It never replaces the source manifests or receipts.

### 5.9 `data/current/analyzed.json`

Legacy analyzed records (leftover from the `fetch-papers.js` direct-run workflow). Not directly used by the current main workflow, but kept for compatibility and included in daily archiving.

---

### 5.10 Blog Journals, Manifests, and Review Receipts

- Generation staging/install journals record each page's input, prior SHA, and expected SHA. Crash recovery adopts only an exact match; the index and strict manifest are created after every paper completes.
- `blog-generation-manifest-YYYY-MM-DD.json`: the formal schema-v3 manifest contains the exact non-empty, unique Markdown file set, input/dependency fingerprints, base HEAD, category, per-file hashes, and the validated `publishedPapers` snapshot actually rendered to the blog. `visualSummaryRequired` and `digestCoverRequired` must both be `false`; post-publication images never enter this manifest.
- `blog-review-passes-YYYY-MM-DD.json` durably stores each passed page's repository-relative path, SHA-256 actually read, pass time, and review-protocol fingerprint at that time. Reuse depends only on path plus SHA; code, script, documentation, model, protocol, generation-manifest, or blog-base changes retain the record, while changed bytes re-review only that page.
- `blog-review-failure-YYYY-MM-DD.json` schema v3 binds the SHA actually read by each worker and retains the attempt's manifest, blog base, and protocol metadata for audit. Changes to those batch fields no longer force unchanged passed pages through full review. Content failures can be selectively re-reviewed, transient failures remain retryable, and missing expected pages or SHA changes across the Hugo gate still block a batch receipt.
- `blog-review-receipt-YYYY-MM-DD.json`: review stores file hashes and each file's actual pass-protocol fingerprint, then binds the current generation-manifest SHA-256, current review protocol, and Hugo gate. After remote OID verification, push adds `publicationCommit`, matching `remoteVerifiedOid`, and Beijing-time `remoteVerifiedAt`. Visual planning reads the actual published set from generation `publishedPapers` and binds both the publication commit and generation SHA into every task token.

All three blog stages share both per-date and repository-global locks. Push verifies staged index blobs/deletions against the receipt after staging and again before commit.

### 5.11 `data/current/xiaohongshu-oneliners-YYYY-MM-DD.json`

Per-paper success cache used only to generate Xiaohongshu copy. Entries are saved under a per-date lock and bind analysis, prompt, model/endpoint configuration, and sanitation fingerprints. Corrupt caches are quarantined and rebuilt; fallbacks or changed inputs rerun only that paper. No automatic publication is involved.

With the default data source, if a same-date `blog-generation-manifest-YYYY-MM-DD.json` exists, copy generation first verifies that its review receipt binds the manifest SHA, strict review, publication commit, and the same remotely verified OID. The schema-v3 `publishedPapers` snapshot then becomes the authoritative set before publish preflight, excluding analysis records that never entered the blog while preventing an unreviewed or remotely unverified manifest from masquerading as published content. Custom input files are not bound to this snapshot.
