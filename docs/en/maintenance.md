# Maintenance Conventions

## Maintenance Conventions

- After any change to workflows, paths, or critical parameters, **you must update** `README.md` and `SKILL.md` accordingly
- When documentation conflicts with code, treat the current script behavior as the source of truth and fix the docs immediately
- **Hard-coding real API keys, WeChat credentials, or Feishu credentials in scripts is prohibited**; all credentials must be read from environment variables
- New scripts must be registered in the command reference in `README.md`, the common-command section in `SKILL.md`, and the syntax-check checklist in `.github/workflows/ci.yml`
- New analysis-related scripts should prefer reusing `analysis-engine.js` to avoid duplicating retry/save logic
- New configurable parameters should be added to `config.js`, with environment variable override support added in tandem
- After modifying `prompts/deep-analysis.md` or `prompts/filter.md`, the code will automatically read the latest content; no code changes are needed
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

**Code post-processing**: `scripts/utils.js` and `scripts/utils.py` recompute the total score from the eight sub-scores in `## 评分理由` via `parseAnalysis`/`parse_analysis`, capping at 10, rounding to 0.1, overriding the raw `## 评分` total from the LLM (which often miscalculates or omits this section).

Machine summary fields:
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
| Technical Rigor | 0-1.5 | Are derivations/proofs correct? Is the algorithm logic sound? Are assumptions reasonable? Are boundary conditions discussed? Is mathematical formulation rigorous? |
| Experimental Soundness | 0-1.5 | Are baselines sufficient and representative? Are ablation studies complete? Is dataset coverage adequate? Do results genuinely support the conclusions? |
| Clarity | 0-1 | Organization, symbol definitions, formula explanations, figure quality. Can a reader understand and reproduce the work without reading the source code? |
| Impact | 0-1.5 | Contribution to the field, potential follow-up value, practical application potential, relevance to speech/music/audio readers |
| Open Source | 0-1.5 | Are code/model/data/checkpoints publicly available? 1.5 requires full open source with complete README and documentation; 1.0 means code is open but model or docs are missing; 0.5 means only partial resources or no documentation link; 0 means completely closed |
| Reproducibility | 0-0.5 | Documentation sufficiency beyond open source—are training details/hyperparameters/hardware environment/reproduction steps sufficient for others to reproduce? |
| Engineering/Practical Value | 0-1.5 | Engineering落地能力, pipeline completeness, practical reference value, industrial reusability. Must be strictly scored for engineering papers (tech reports, system reports, benchmark construction) |

### 14.3 Tier Requirements

- `rank_bucket` must be chosen from `前10% / 前25% / 前50% / 后50%`
- `9.0-10.0`: Breakthrough contribution, candidate for a field milestone; method or results have paradigm-shifting potential
- `8.0-8.5`: High-quality work making solid contributions on important problems, with clear impact or significant performance gains
- `6.5-7.5`: Valuable but not outstanding, or has minor flaws; fair to good, with reference value for researchers in specific directions
- `5.0-6.0`: Limited innovation, weak experiments, conclusions of insufficient importance, or obvious flaws; suitable only for a quick skim
- `1.0-4.5`: Serious problems, incorrect derivations, experiments that do not support conclusions, or extremely poor writing; not recommended to invest time

### 14.4 Tag Output Requirements

- Final tag count must be 3-5
- Must include at least 1 [Task] tag and 1 [Method/Model] tag
- Must also output `primary_task_tag`, `primary_method_tag`, and `supplementary_tags`
- `primary_task_tag` and `primary_method_tag` may each have only 1 value, and must be drawn from the final tag set
- Choose either `音频大模型` or `语音大模型`; when using `多模态模型`, do not also tag `音视频`

### 14.5 Output Contract Change Checklist

When `prompts/deep-analysis.md` or scoring/tag specifications change, at minimum verify the following:

1. Confirm that `loadPrompt()` in `scripts/utils.js` correctly reads markdown files under `prompts/`
2. Check whether `scripts/utils.js` and `scripts/utils.py` can still correctly parse `## 机器摘要`, tags, and score fields (note that machine summary headers changed from `###` to `##`)
3. Sample-check `data/current/deep-analysis-result.json` to confirm the presence of `rank_bucket`, `primary_task_tag`, and `primary_method_tag`
4. **Verify that `score` is correctly computed from the eight sub-scores in `## 评分理由`**: sample-compare `parsed.score` against the sum of sub-scores in `## 评分理由`, confirming cap of 10 and rounding to 0.1
5. Verify blog publishing script artifacts, confirming that leaderboards, single-post pages, and trending directions correctly display new fields
6. Verify WeChat/Xiaohongshu/Feishu script artifacts, confirming that copy does not contain null values or formatting misalignment caused by missing fields
7. Confirm that the new `## 局限与问题` section is correctly displayed in blog/social media (if applicable)

---

---

## References and Acknowledgments

- This project references the ideas and structure of [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) in its design and implementation
