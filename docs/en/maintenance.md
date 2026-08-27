# Maintenance Conventions

## Maintenance Conventions

- After any change to workflows, paths, or critical parameters, **you must update** `README.md` and `SKILL.md` accordingly
- When documentation conflicts with code, treat the current script behavior as the source of truth and fix the docs immediately
- **Hard-coding real API keys, WeChat credentials, or Feishu credentials in scripts is prohibited**; all credentials must be written to the current project-root `.env` and loaded through the project env loader
- New scripts must be registered in the command reference in `README.md`, the common-command section in `SKILL.md`, and the syntax-check checklist in `.github/workflows/ci.yml`
- New analysis-related scripts should prefer reusing `analysis-engine.js` to avoid duplicating retry/save logic
- New configurable parameters should be added to `config.js`, with project `.env` override support added in tandem
- Prompt text is loaded at runtime, but any output-contract change in `prompts/deep-analysis.md` must be synchronized with JS/Python parsers, validators, fixtures, and publishing preflight
- After modifying the output contract of `deep-analyzer.js`, check `scripts/utils.js` and `scripts/utils.py` for required updates
- After modifying `config.js`, update `tests/config.test.js` accordingly
- After modifying scoring, tags, or machine-summary formats, sample-verify `data/current/deep-analysis-result.json` and the final blog/social media artifacts
- **Security audit**: Periodically check the codebase for accidental leaks of API keys, tokens, credential backup files, or environment variable snapshots; temporary/backup files under `data/` and `logs/` must never be committed to version control
- **`.gitignore` requirements**: Ensure `data/`, `logs/`, `*.env`, `*.backup*`, `.DS_Store`, `*-cache.json`, sensitive logs, and similar items are properly ignored

---

---

## Appendix: Current Scoring and Tag Specifications

`deep-analyzer.js` currently uses an eight-dimensional scoring system in the style of top-tier conference reviewers (NeurIPS/ICML/ICLR), and requires a machine summary to be output simultaneously:

### 14.1 Scoring Formula

Dimension maxima: Innovation (0–2) + Technical Rigor (0–1.5) + Experimental Soundness (0–1.5) + Clarity (0–1) + Impact (0–1.5) + Open Source (0–1.5) + Reproducibility (0–0.5) + Engineering/Practical Value (0–1.5) = 11. Total score = sum of all dimensions, capped at 10 (anything above 10 is counted as 10), rounded to 0.1.

**Code post-processing**: `scripts/utils.js` and `scripts/utils.py` recompute the total only when all eight dimensions are present exactly once, use the required denominators, contain finite values with at most one decimal, and stay within range; Open Source must use a fixed anchor. Invalid or incomplete scoring produces a contract error and cannot be saved or published, including through Python manual overrides. A total of zero is valid; there is no implicit one-point floor.

The current contract is `type-aware-v1`. Scoring must first output `document_type`, exactly one of 方法研究, 系统技术报告, 模型报告, 数据集与基准, 综述, 理论研究, or 应用研究. Parsers write `scoringRubricVersion: type-aware-v1` only when the analysis contains a valid document type, preserving backward compatibility for historical results.

Machine summary fields:
- `document_type` (controlled document type)
- `rank_bucket` (top 10% / top 25% / top 50% / bottom 50%)
- `innovation` (innovation, range 0-2)
- `technical_rigor` (technical rigor, range 0-1.5)
- `experimental_sufficiency` (experimental soundness, range 0-1.5)
- `clarity` (clarity, range 0-1)
- `impact` (impact and significance, range 0-1.5)
- `open_source` (open-source completeness, range 0-1.5)
- `reproducibility` (reproducibility, range 0-0.5)
- `engineering_score` (engineering/practical value, range 0-1.5)
- `confidence`
- `primary_task_tag`
- `primary_method_tag`
- `sota_claim`
- `has_code`
- `has_model`
- `has_dataset`

### 14.2 Eight-Dimensional Sub-score Definitions

| Dimension | Range | Description |
|-----------|-------|-------------|
| Innovation | 0-2 | Is the problem novel? Does the method represent a fundamental breakthrough? Is the insight deep? Is the distinction from SOTA clear and convincing? |
| Technical Rigor | 0-1.5 | Correctness of disclosed derivations, proofs, algorithm/system logic, assumptions, and boundaries; closed source or missing hyperparameters do not belong here |
| Experimental Soundness | 0-1.5 | Whether evidence appropriate to `document_type` supports the core claims; component ablations are mandatory only for component-level causal claims |
| Clarity | 0-1 | Organization, notation, formulas, figures, and presentation only; missing reproduction detail belongs to Reproducibility |
| Impact | 0-1.5 | Contribution to the field, potential follow-up value, practical application potential, relevance to speech/music/audio readers |
| Open Source | 0-1.5 | Fixed anchors: 1.5 for complete core code/model/data with complete documentation; 1.2 when core artifacts are released but documentation is incomplete; 1.0 for only some core artifacts; 0.5 for an explicit future release promise with nothing released yet; 0.2 for demo-only with no core artifact; 0 for fully closed with no promise |
| Reproducibility | 0-0.5 | Documentation sufficiency beyond open source—are training details/hyperparameters/hardware environment/reproduction steps sufficient for others to reproduce? |
| Engineering/Practical Value | 0-1.5 | Practical deployment maturity, pipeline completeness, practical reference value, industrial reusability. Must be strictly scored for engineering papers (tech reports, system reports, benchmark construction) |

### 14.3 Type-specific Evidence and Deduction Ownership

| Document Type | Primary Evidence |
|---------------|------------------|
| 方法研究 | Representative baselines, ablations, cross-dataset generalization, statistics, error analysis |
| 系统技术报告 / 模型报告 | End-to-end quality, latency, throughput, cost, scale, stress tests, fair comparisons, failure cases |
| 数据集与基准 | Coverage, annotation quality, leakage controls, evaluation protocol, baseline completeness |
| 综述 | Search methodology, coverage, taxonomy, comparison framework, synthesis |
| 理论研究 | Proof correctness, assumptions, boundaries, counterexamples |
| 应用研究 | Real-world setting, external validation, user studies, deployment constraints |

Type selects the evidence standard and grants no fixed bonus, floor, or exemption. Apply claim-evidence matching and single-issue-single-primary-dimension deductions: artifacts belong to Open Source, reproduction detail to Reproducibility, unsupported claims to Experimental Soundness, presentation to Clarity, and logic/derivation/assumption errors to Technical Rigor. Complete public proofs, derivations, and appendices may be a theory paper's core public artifact, so absent code/model/data flags do not force its Open Source score to zero. Lower `confidence` when evidence cannot be verified.

The final scoring audit is primary-model JSON. Code rejects cross-dimension rationales and feeds the exact error into the next local audit attempt instead of immediately restarting full-text analysis. Non-theory papers with no released core artifact are normalized to the 0.5 / 0.2 / 0 anchors above; theory retains the type-aware judgment based on public proof material.

### 14.4 Tier Requirements

- `rank_bucket` must be chosen from `前10% / 前25% / 前50% / 后50%`
- `9.0-10.0`: Breakthrough contribution, candidate for a field milestone; method or results have paradigm-shifting potential
- `8.0-8.5`: High-quality work making solid contributions on important problems, with clear impact or significant performance gains
- `6.5-7.5`: Valuable but not outstanding, or has minor flaws; fair to good, with reference value for researchers in specific directions
- `5.0-6.0`: Limited innovation, weak experiments, conclusions of insufficient importance, or obvious flaws; suitable only for a quick skim
- `1.0-4.5`: Serious problems, incorrect derivations, experiments that do not support conclusions, or extremely poor writing; not recommended to invest time

### 14.5 Tag Output Requirements

- Final tag count must be 3-5
- Must include at least 1 [Task] tag and 1 [Method/Model] tag
- Must also output `primary_task_tag`, `primary_method_tag`, and `supplementary_tags`
- `primary_task_tag` and `primary_method_tag` may each have only 1 value, and must be drawn from the final tag set
- Choose either `音频大模型` or `语音大模型`; when using `多模态模型`, do not also tag `音视频`

### 14.6 Output Contract Change Checklist

When `prompts/deep-analysis.md` or scoring/tag specifications change, at minimum verify the following:

1. Confirm that `loadPrompt()` in `scripts/utils.js` correctly reads markdown files under `prompts/`
2. Check whether `scripts/utils.js` and `scripts/utils.py` can still correctly parse `## 机器摘要`, tags, and score fields (note that machine summary headers changed from `###` to `##`)
3. Sample-check `data/current/deep-analysis-result.json`: confirm `document_type`, `rank_bucket`, `primary_task_tag`, and `primary_method_tag` in the raw machine summary, plus `documentType`, `scoringRubricVersion`, and the corresponding camelCase fields in `parsed`
4. **Verify that `score` is correctly computed from the eight sub-scores in `## 评分理由`**: sample-compare `parsed.score` against the sum of sub-scores in `## 评分理由`, confirming cap of 10 and rounding to 0.1
5. Verify blog publishing script artifacts, confirming that leaderboards, single-post pages, and trending directions correctly display new fields
6. Verify WeChat/Xiaohongshu/Feishu script artifacts, confirming that copy does not contain null values or formatting misalignment caused by missing fields
7. Confirm the correct publication boundary: Manual v5 presents limitations/counterevidence in the relevant paper-specific `readerArticle` section and retains final score evidence; only legacy-compatible pages or the automatic API canonical layout display `## 局限与问题` directly

---

---

## References and Acknowledgments

- This project references the ideas and structure of [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) in its design and implementation
